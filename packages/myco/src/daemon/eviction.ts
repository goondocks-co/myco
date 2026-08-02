/**
 * Unified daemon-eviction helpers.
 *
 * One source of truth for "find every myco daemon competing for this
 * daemon's identity and make them go away so we can take the canonical
 * port." Sole caller: `server.evictExistingDaemon` (daemon startup).
 *
 * Identity is an explicit {@link EvictionScope} — the service state dir
 * (where daemon.json actually lives) plus the canonical port the daemon
 * will bind. The prior shape derived BOTH from `vaultDir`, which is the
 * legacy per-vault protocol: the global daemon keeps its state under the
 * service dir (`~/.myco/service`) and derives its port from that dir, so a
 * vault-derived sweep scanned a port nobody uses, read a daemon.json that
 * doesn't exist there, and the cwd-based identity probe could not even
 * recognize a launchd-spawned daemon (cwd never resolves to the bootstrap
 * vault). The orphan sweep was a structural no-op in every current config.
 *
 * Port squatters are identified as myco daemons via, in order:
 *   1. the pid recorded in the scope's daemon.json (healthy case),
 *   2. a `/health` probe on the squatted port answering `{myco: true}` —
 *      a listener that speaks the myco heartbeat IS a myco daemon,
 *      regardless of how it was spawned or what its cwd looks like,
 *   3. the legacy cwd→vault check, kept for per-vault daemons.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  DAEMON_EVICT_POLL_MS,
  DAEMON_EVICT_TIMEOUT_MS,
  DAEMON_HEALTH_CHECK_TIMEOUT_MS,
  KNOWN_EXTERNAL_MCP_POSTURES,
} from '../constants.js';
import {
  cleanStaleDaemonJson,
  findPidsListeningOn,
  findVaultFromCwd,
  isProcessAlive,
  parseLsofOutput,
  readProcessCwd,
  terminateProcess,
} from '@goondocks/myco-shared';

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

/**
 * The identity this eviction acts for. `stateDir` is where the daemon's
 * `daemon.json` lives (the SERVICE dir for global daemons — e.g.
 * `~/.myco/service/` — not the project vault); `canonicalPort` is the port
 * the caller is about to bind. `vaultDir` enables the legacy cwd→vault
 * identity check for per-vault daemons and is optional.
 */
export interface EvictionScope {
  stateDir: string;
  canonicalPort: number;
  vaultDir?: string;
}

export interface MycoDaemonHeartbeat {
  myco?: boolean;
  version?: string;
  pid?: number;
  external_mcp_activation?: string;
}

/** True only when the responding daemon proves the retired activation posture. */
export function isRetiredExternalMcpDaemon(
  heartbeat: MycoDaemonHeartbeat,
  expectedPid?: number,
): boolean {
  const pidMatches = expectedPid === undefined
    ? typeof heartbeat.pid === 'number'
    : heartbeat.pid === expectedPid;
  return heartbeat.myco === true
    && pidMatches
    // Accepted set DERIVED from the exported constant (spec R-Q2 gate) — a
    // posture is steppable-aside only if this binary knows how to reconcile
    // what that posture implies at its own boot.
    && (KNOWN_EXTERNAL_MCP_POSTURES as readonly string[]).includes(
      String(heartbeat.external_mcp_activation),
    );
}

/**
 * Probe `/health` on a local port. Returns the parsed heartbeat for a myco
 * daemon, null for anything else (non-myco listener, timeout, no listener).
 */
export async function probeMycoDaemon(
  port: number,
  timeoutMs = DAEMON_HEALTH_CHECK_TIMEOUT_MS,
): Promise<MycoDaemonHeartbeat | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as MycoDaemonHeartbeat;
    return data.myco === true ? {
      myco: true,
      version: data.version,
      pid: data.pid,
      external_mcp_activation: data.external_mcp_activation,
    } : null;
  } catch {
    return null;
  }
}

const LOG_KIND = 'daemon.eviction';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evict every myco daemon competing for the scope's identity.
 *
 * Looks at both the PID recorded in the scope's `daemon.json` and any myco
 * daemon holding a port in the scope's canonical range. SIGTERMs with a
 * grace period, escalates to SIGKILL, then waits for the process to exit.
 *
 * Safe to call before the caller has bound its own port (the current process
 * is excluded from the kill list).
 */
export async function evictDaemons(
  scope: EvictionScope,
  opts: EvictOptions = {},
): Promise<EvictionTarget[]> {
  const logger = opts.logger;
  const graceMs = opts.graceMs ?? DAEMON_EVICT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DAEMON_EVICT_POLL_MS;

  const targets = await findDaemonTargets(scope);
  if (targets.length === 0) return [];

  logger?.info(LOG_KIND, 'Evicting daemons for scope', {
    state_dir: scope.stateDir,
    canonical_port: scope.canonicalPort,
    targets: targets.map((t) => ({ pid: t.pid, source: t.source })),
  });

  await Promise.all(
    targets.map((t) => terminateProcess(t.pid, { graceMs, pollMs, logger })),
  );

  // Best-effort: unlink daemon.json if it still points at one of the evicted
  // PIDs. Leaving it can cause subsequent startups to "step aside" from a
  // process we just killed.
  cleanStaleDaemonJson(scope.stateDir, targets.map((t) => t.pid));
  return targets;
}

/**
 * Return the union of (daemon.json PID, canonical-port squatters) for the
 * scope.
 *
 * Filtered to myco daemons only, deduplicated, and excluding the current
 * process. Port squatters that are NOT myco daemons are ignored — we don't
 * want to kill an unrelated service just because it grabbed our preferred
 * port. Async because squatter identity may require a `/health` probe.
 */
export async function findDaemonTargets(scope: EvictionScope): Promise<EvictionTarget[]> {
  const seen = new Map<number, EvictionTarget>();

  const jsonPid = readDaemonJsonPid(scope.stateDir);
  if (jsonPid !== undefined && jsonPid !== process.pid && isProcessAlive(jsonPid)) {
    seen.set(jsonPid, { pid: jsonPid, source: 'daemon.json' });
  }

  const portsToScan = rangeInclusive(scope.canonicalPort, scope.canonicalPort + EVICT_PORT_SCAN_RANGE - 1)
    .filter((p) => p <= 65535);
  const squatters = findPidsListeningOn(portsToScan);
  for (const { port, pid } of squatters) {
    if (pid === process.pid) continue;
    if (seen.has(pid)) continue;
    if (pid === jsonPid) { seen.set(pid, { pid, source: `port:${port}` }); continue; }
    const isMyco =
      (await probeMycoDaemon(port)) !== null ||
      (scope.vaultDir !== undefined && isMycoDaemonForVault(pid, scope.vaultDir));
    if (!isMyco) continue;
    seen.set(pid, { pid, source: `port:${port}` });
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function readDaemonJsonPid(stateDir: string): number | undefined {
  try {
    const jsonPath = path.join(stateDir, 'daemon.json');
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const info = JSON.parse(raw) as { pid?: unknown };
    return typeof info.pid === 'number' ? info.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull the first path-shaped line out of the Windows cwd PowerShell output.
 *
 * The command prints one line — the process's current directory — but real
 * PowerShell output can carry a trailing newline, BOM, or (on error) a
 * diagnostic preamble. Accept the first drive-letter (`C:\...`, forward or
 * back slash) or UNC (`\\host\share`) line; return null when nothing
 * path-shaped survives, so the caller degrades to the `/health` probe.
 */
export function parseWindowsProcessCwd(out: string): string | null {
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line) continue;
    if (/^[a-zA-Z]:[\\/]/.test(line) || line.startsWith('\\\\')) return line;
  }
  return null;
}

/**
 * Build the PowerShell command that prints a best-effort working directory
 * for `pid`.
 *
 * Win32_Process exposes no current-directory column and a running process's
 * live cwd is not retrievable cross-process without native PEB reads, so we
 * use the executable's containing directory (`Split-Path -Parent $p.Path`) as
 * the degraded signal. For a per-vault daemon launched from inside its project
 * tree, that directory walks up to the enclosing `.myco/` via
 * {@link findVaultFromCwd} and matches; for a self-contained binary started
 * elsewhere it simply won't match, and the caller falls back to the `/health`
 * probe — the primary Windows identity path (see module header). Gated behind
 * win32 and wrapped in try/null so any failure (no such pid, ACL denial, no
 * PowerShell) degrades exactly as today.
 *
 * Kept as a builder so the exact command text is unit-testable without
 * shelling out.
 */
export function buildWindowsCwdCommand(pid: number): string {
  return [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($p -and $p.Path) { Split-Path -Parent $p.Path }',
  ].join('; ');
}

/**
 * Windows process cwd via PowerShell + CIM, mirroring the shared
 * `readProcessCommandLine` win32 pattern (same `powershell.exe` invocation,
 * same 3s timeout, same null-on-failure contract).
 *
 * `runShell` is injectable so the command construction and parsing are
 * unit-testable without a real PowerShell.
 */
export function readWindowsProcessCwd(
  pid: number,
  runShell: (pid: number) => string = defaultWindowsCwdShell,
): string | null {
  try {
    return parseWindowsProcessCwd(runShell(pid));
  } catch {
    return null;
  }
}

function defaultWindowsCwdShell(pid: number): string {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', buildWindowsCwdCommand(pid)],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
  );
}

/**
 * cwd for `pid`, with a Windows fallback the shared `readProcessCwd` lacks.
 *
 * The shared helper implements Linux (`/proc/<pid>/cwd`) and Darwin (`lsof`)
 * but returns null on win32. Without a win32 branch a Windows orphan daemon
 * whose `daemon.json` was lost can't be identity-matched by cwd. This wrapper
 * shells to PowerShell on win32 (same pattern as the shared
 * `readProcessCommandLine`) and otherwise defers to the shared helper, so
 * POSIX behavior is unchanged.
 */
function readProcessCwdCrossPlatform(pid: number): string | null {
  const cwd = readProcessCwd(pid);
  if (cwd) return cwd;
  if (process.platform === 'win32') return readWindowsProcessCwd(pid);
  return null;
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
 * `lsof -p <pid> -d cwd` on Darwin, and `Get-CimInstance Win32_Process`
 * (via {@link readWindowsProcessCwd}) on Windows. When cwd can't be obtained
 * the check returns false and the caller falls back to the `/health` port
 * probe — degrading gracefully rather than mis-evicting.
 */
export function isMycoDaemonForVault(pid: number, vaultDir: string): boolean {
  if (readDaemonJsonPid(vaultDir) === pid) return true;

  const cwd = readProcessCwdCrossPlatform(pid);
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
