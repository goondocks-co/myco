/**
 * Unified daemon-eviction helpers.
 *
 * One source of truth for "find every myco daemon running for this vault and
 * make them go away so we can take the canonical port." Callers:
 *   - `server.evictExistingDaemon` (daemon startup)
 *   - `cli/restart.ts` (user-triggered restart)
 *
 * The prior eviction logic looked only at the PID recorded in `daemon.json`.
 * That missed two real failure modes:
 *   - An orphan daemon holding the canonical port whose JSON registration got
 *     lost (racing update-apply, unclean shutdown, stale-JSON SIGTERM that
 *     the target process ignored).
 *   - A "current" daemon that fell back to `canonical+1` because an orphan was
 *     squatting the canonical port; subsequent restarts keep using the wrong
 *     port forever because daemon.json points at the fallback.
 *
 * This module scans a small port range around the canonical port (which was
 * the fallback-retry range before we dropped silent fallback) to catch any
 * historical fallback-bound myco daemons, identifies them via `ps` argv
 * matching, and evicts them all.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { derivePort } from './port.js';
import {
  DAEMON_EVICT_POLL_MS,
  DAEMON_EVICT_TIMEOUT_MS,
} from '../constants.js';

/** How many ports above the canonical to scan for stale daemons. */
const EVICT_PORT_SCAN_RANGE = 10;

/** Minimal logger shape so this module works for both daemon and CLI callers. */
export interface EvictionLogger {
  info: (event: string, message: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, message: string, meta?: Record<string, unknown>) => void;
}

export interface EvictOptions {
  /** Grace period between SIGTERM and SIGKILL (ms). Default: {@link DAEMON_EVICT_TIMEOUT_MS}. */
  graceMs?: number;
  /** Poll interval while waiting for process exit (ms). Default: {@link DAEMON_EVICT_POLL_MS}. */
  pollMs?: number;
  /** Optional logger. Falls back to silent when omitted. */
  logger?: EvictionLogger;
}

/** Source that surfaced a PID — useful for logs and tests. */
export type PidSource = 'daemon.json' | `port:${number}`;

export interface EvictionTarget {
  pid: number;
  source: PidSource;
}

const LOG_KIND = 'daemon.eviction';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evict every myco daemon running for `vaultDir`.
 *
 * Looks at both the PID in `daemon.json` and any myco daemon holding a port
 * in the canonical range derived from `vaultDir`. SIGTERMs with a grace
 * period, escalates to SIGKILL, then waits for the process to exit.
 *
 * Safe to call before the caller has bound its own port (the current process
 * is excluded from the kill list).
 */
export async function evictDaemonsForVault(
  vaultDir: string,
  opts: EvictOptions = {},
): Promise<EvictionTarget[]> {
  const logger = opts.logger;
  const graceMs = opts.graceMs ?? DAEMON_EVICT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DAEMON_EVICT_POLL_MS;
  const canonicalPort = derivePort(vaultDir);

  const targets = findDaemonTargetsForVault(vaultDir, canonicalPort);
  if (targets.length === 0) return [];

  logger?.info(LOG_KIND, 'Evicting daemons for vault', {
    vault: vaultDir,
    canonical_port: canonicalPort,
    targets: targets.map((t) => ({ pid: t.pid, source: t.source })),
  });

  await Promise.all(
    targets.map((t) => terminateProcess(t.pid, { graceMs, pollMs, logger })),
  );

  // Best-effort: unlink daemon.json if it still points at one of the evicted
  // PIDs. Leaving it can cause subsequent startups to "step aside" from a
  // process we just killed.
  cleanStaleDaemonJson(vaultDir, targets.map((t) => t.pid));

  return targets;
}

/**
 * Return the union of (daemon.json PID, canonical-port squatters) for a vault.
 *
 * Filtered to myco daemons only, deduplicated, and excluding the current
 * process. Port squatters that are NOT myco daemons for this vault are
 * ignored — we don't want to kill an unrelated service just because it
 * grabbed our preferred port.
 */
export function findDaemonTargetsForVault(
  vaultDir: string,
  canonicalPort: number,
): EvictionTarget[] {
  const seen = new Map<number, EvictionTarget>();

  const jsonPid = readDaemonJsonPid(vaultDir);
  if (jsonPid !== undefined && jsonPid !== process.pid && isProcessAlive(jsonPid)) {
    seen.set(jsonPid, { pid: jsonPid, source: 'daemon.json' });
  }

  const portsToScan = rangeInclusive(canonicalPort, canonicalPort + EVICT_PORT_SCAN_RANGE - 1)
    .filter((p) => p <= 65535);
  const squatters = findPidsListeningOn(portsToScan);
  for (const { port, pid } of squatters) {
    if (pid === process.pid) continue;
    if (seen.has(pid)) continue;
    if (!isMycoDaemonForVault(pid, vaultDir)) continue;
    seen.set(pid, { pid, source: `port:${port}` });
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Process termination
// ---------------------------------------------------------------------------

interface TerminateOpts {
  graceMs: number;
  pollMs: number;
  logger?: EvictionLogger;
}

/** SIGTERM → poll → SIGKILL → verify. Resolves when the process is gone. */
export async function terminateProcess(pid: number, opts: TerminateOpts): Promise<void> {
  const { graceMs, pollMs, logger } = opts;

  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already dead between isAlive and kill
  }

  if (await waitForProcessExit(pid, graceMs, pollMs)) return;

  logger?.warn(LOG_KIND, 'Daemon did not exit after SIGTERM, escalating to SIGKILL', {
    pid,
    grace_ms: graceMs,
  });

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return; // died during the escalation window
  }

  // Short verify window — the kernel normally reaps promptly after SIGKILL.
  if (await waitForProcessExit(pid, pollMs * 5, pollMs)) return;

  logger?.warn(LOG_KIND, 'Daemon still alive after SIGKILL', { pid });
}

/** Poll `process.kill(pid, 0)` until it throws (dead) or the deadline passes. */
async function waitForProcessExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function readDaemonJsonPid(vaultDir: string): number | undefined {
  try {
    const jsonPath = path.join(vaultDir, 'daemon.json');
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const info = JSON.parse(raw) as { pid?: unknown };
    return typeof info.pid === 'number' ? info.pid : undefined;
  } catch {
    return undefined;
  }
}

interface PortOwner {
  port: number;
  pid: number;
}

/**
 * Return PIDs currently LISTENing on any of the given ports, via `lsof`.
 *
 * Shelling out to `lsof` is a deliberate choice: Node's net APIs only report
 * whether a port is bindable, not who owns it. `lsof` is present on both
 * Darwin and Linux; the Bun single-file binary can invoke it the same way.
 */
export function findPidsListeningOn(ports: number[]): PortOwner[] {
  if (ports.length === 0) return [];
  const range = formatPortRange(ports);

  let stdout: string;
  try {
    stdout = execFileSync(
      'lsof',
      ['-iTCP:' + range, '-sTCP:LISTEN', '-nP', '-F', 'pn'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
    );
  } catch {
    // `lsof` exits non-zero when nothing matches — treat as "no squatters".
    return [];
  }

  return parseLsofOutput(stdout);
}

/**
 * Parse the `-F pn` field-formatted output of `lsof`. Each record starts with
 * `p<pid>`; subsequent `n` lines give the name (e.g. `127.0.0.1:21039`) which
 * we parse to extract the listening port.
 */
export function parseLsofOutput(stdout: string): PortOwner[] {
  const owners: PortOwner[] = [];
  let currentPid: number | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isFinite(pid) ? pid : undefined;
    } else if (line.startsWith('n') && currentPid !== undefined) {
      const match = line.match(/:(\d+)$/);
      if (!match?.[1]) continue;
      const port = Number(match[1]);
      if (!Number.isFinite(port)) continue;
      owners.push({ port, pid: currentPid });
    }
  }
  return owners;
}

/**
 * True when `pid` is a myco daemon process invoked with `--vault <vaultDir>`.
 *
 * Uses `ps -p <pid> -o args=` and matches against the resolved vault path.
 * Handles both `--vault /path` and `--vault=/path` forms.
 */
export function isMycoDaemonForVault(pid: number, vaultDir: string): boolean {
  let args: string;
  try {
    args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return false;
  }
  return matchesMycoDaemonInvocation(args, vaultDir);
}

/** Extracted for direct testability without spawning `ps`. */
export function matchesMycoDaemonInvocation(args: string, vaultDir: string): boolean {
  if (args.length === 0) return false;

  const flagIndex = args.indexOf('--vault');
  if (flagIndex < 0) return false;

  // "myco" must appear in the command portion BEFORE --vault — not in the
  // vault path itself. Otherwise a vault at `/home/me/myco-stuff/.myco`
  // would spuriously match any `node ... daemon --vault /home/me/myco-stuff/.myco`.
  const head = args.slice(0, flagIndex);
  if (!/myco/i.test(head)) return false;
  if (!/(^|[\s/])daemon(\s|$)/.test(head)) return false;

  const resolved = path.resolve(vaultDir);
  const attached = `--vault=${resolved}`;
  if (args.includes(attached)) return true;

  const tail = args.slice(flagIndex + '--vault'.length).replace(/^[=\s]+/, '');
  if (tail.length === 0) return false;

  // `tail` may continue with additional flags; take the next token only.
  const nextArg = tail.split(/\s+/, 1)[0] ?? '';
  return path.resolve(nextArg) === resolved;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rangeInclusive(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}

function formatPortRange(ports: number[]): string {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? `${first}` : `${first}-${last}`;
}

function cleanStaleDaemonJson(vaultDir: string, evictedPids: number[]): void {
  try {
    const jsonPath = path.join(vaultDir, 'daemon.json');
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const info = JSON.parse(raw) as { pid?: unknown };
    if (typeof info.pid === 'number' && evictedPids.includes(info.pid)) {
      fs.unlinkSync(jsonPath);
    }
  } catch {
    // daemon.json already absent or a sibling wrote a new one — leave it.
  }
}
