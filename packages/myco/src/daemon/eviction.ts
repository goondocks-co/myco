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

import fs from 'node:fs';
import path from 'node:path';

import { derivePort } from './port.js';
import {
  DAEMON_EVICT_POLL_MS,
  DAEMON_EVICT_TIMEOUT_MS,
} from '../constants.js';
import {
  cleanStaleDaemonJson,
  findPidsListeningOn,
  findVaultFromCwd,
  isProcessAlive,
  parseLsofOutput,
  readProcessCwd,
  terminateProcess,
} from '@myco-shared/index.js';

export {
  findPidsListeningOn,
  findVaultFromCwd,
  parseLsofOutput,
  readProcessCwd,
  terminateProcess,
};

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

/**
 * True when `pid` is a myco daemon process whose cwd belongs to `vaultDir`.
 *
 * Identity is established via two cross-checks, in order:
 *   1. `daemon.json`'s recorded pid — the healthy case. O(1) file read.
 *   2. The pid's own cwd, resolved to its nearest enclosing `.myco/`.
 *      Catches orphan daemons whose `daemon.json` was lost (e.g. racy
 *      update-apply, unclean shutdown, stale-JSON removal).
 *
 * cwd introspection is platform-specific: `/proc/<pid>/cwd` on Linux,
 * `lsof -p <pid> -d cwd` on Darwin. On unsupported platforms the
 * fallback returns false, meaning orphans with lost JSON may go
 * un-evicted there; operators must kill such processes manually.
 */
export function isMycoDaemonForVault(pid: number, vaultDir: string): boolean {
  if (readDaemonJsonPid(vaultDir) === pid) return true;

  const cwd = readProcessCwd(pid);
  if (!cwd) return false;

  const resolvedVault = findVaultFromCwd(cwd);
  if (!resolvedVault) return false;

  // Compare via realpath when both sides exist so macOS's /var → /private/var
  // symlink (and similar) doesn't produce a false mismatch. Fall back to
  // plain resolve() if either path is unresolvable.
  try {
    return fs.realpathSync(resolvedVault) === fs.realpathSync(vaultDir);
  } catch {
    return path.resolve(resolvedVault) === path.resolve(vaultDir);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rangeInclusive(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}
