/**
 * Daemon service state — `~/.myco/service/daemon.json` and the dir it
 * lives in.
 *
 * ## TRUST MODEL — daemon.json drives code execution
 *
 * daemon.json carries:
 *   - the daemon-issued bearer token (`auth_token`) that gates every
 *     authenticated HTTP endpoint, including grove-claim and intent
 *     write paths. A reader of this token can issue arbitrary daemon
 *     commands as the running user, which transitively includes
 *     restarts, updates (npm install), and grove writes.
 *   - the daemon's pid + canonical port, which the launcher
 *     (`myco-run.cjs`, `bin/myco.cjs`) consults to route MCP calls.
 *   - the `command` field that the launcher uses as the trusted myco
 *     binary path.
 *
 * Protections (single-machine, single-user trust boundary):
 *   - `~/.myco/service/` is chmod 0o700 (see `writeDaemonState` below)
 *     so directory enumeration is owner-only. This protects sibling
 *     files in the same dir (intent.{restart,update}.toml,
 *     update-error.json, logs/) too.
 *   - daemon.json itself is chmod 0o600 via `atomicWriteFileSync({ mode })`.
 *     The atomic helper opens the tempfile with `O_CREAT|O_EXCL|O_WRONLY`
 *     + a random suffix so the mode lands at create time (no umask
 *     window) and the path is not predictable.
 *   - `readDaemonState` validates pid + port are numbers before
 *     returning; any consumer that calls `kill()` on `state.pid` also
 *     cross-checks `isProcessAlive` to refuse fabricated pids (see
 *     `discoverViaHealth` in main.ts, Bucket C.8).
 *
 * Any future writer must preserve mode 0o600. Any new field that
 * influences execution (command path, auth token, restart toggles) must
 * be validated at read AND write — the file is daemon-executed, not
 * merely daemon-read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import {
  resolveMycoHome,
  resolveServiceDaemonStatePath,
  resolveServiceDir,
} from '@myco/grove/paths.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readJsonFile } from '../utils/json.js';
import { derivePort } from './port.js';

export class GroveBindingRequiredError extends Error {
  constructor(vaultDir: string) {
    super(
      `Grove binding required at ${vaultDir}: project.toml has no [grove].binding_id. `
      + `Run \`myco init\` to bind this project to a Grove. There is no per-vault daemon fallback.`,
    );
    this.name = 'GroveBindingRequiredError';
  }
}

export type DaemonServiceScope = 'global';

export interface DaemonState {
  pid: number;
  port: number;
  command?: string | null;
  started?: string;
  sessions?: string[];
  version?: string;
  /**
   * Daemon-issued bearer token surfaced via `MYCO_DAEMON_AUTH` and the
   * `x-myco-auth` header. Local children inherit it through the env;
   * the daemon also writes it here so newer-than-spawn children
   * (manual `myco doctor`, third-party tools) can fetch it from
   * daemon.json. Absent when the daemon predates G4.
   */
  auth_token?: string;
}

export interface DaemonServiceState {
  scope: DaemonServiceScope;
  stateDir: string;
  statePath: string;
  canonicalPort: number;
}

export interface ResolveDaemonServiceStateOptions {
  requestContext?: MycoRequestContext;
  env?: Record<string, string | undefined>;
}

export function resolveGlobalDaemonPort(mycoHome = resolveMycoHome()): number {
  return derivePort(resolveServiceDir(mycoHome));
}

export function resolveDaemonServiceState(
  vaultDir: string,
  options: ResolveDaemonServiceStateOptions = {},
): DaemonServiceState {
  const mycoHome = resolveMycoHome({ env: options.env as NodeJS.ProcessEnv | undefined });
  const statePath = resolveServiceDaemonStatePath(mycoHome);
  return {
    scope: 'global',
    stateDir: path.dirname(statePath),
    statePath,
    canonicalPort: resolveGlobalDaemonPort(mycoHome),
  };
}

/**
 * Throws if the vault has no Grove binding (neither the supplied
 * requestContext.groveId nor the overlaid `manifest.grove.binding_id`).
 * Call from daemon startup or other paths that genuinely require a
 * binding — read-only helpers (doctor, logs, setup-llm) can resolve
 * the daemon state directly without this gate.
 */
export function assertGroveBound(
  vaultDir: string,
  options: ResolveDaemonServiceStateOptions = {},
): void {
  if (options.requestContext?.groveId) return;
  const manifest = loadProjectManifest(vaultDir);
  if (manifest?.grove?.binding_id) return;
  throw new GroveBindingRequiredError(vaultDir);
}

export function resolveDaemonLogDir(
  vaultDir: string,
  options: ResolveDaemonServiceStateOptions = {},
): string {
  return path.join(resolveDaemonServiceState(vaultDir, options).stateDir, 'logs');
}

function isDaemonState(value: unknown): value is DaemonState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DaemonState>;
  return typeof v.pid === 'number' && typeof v.port === 'number';
}

export function readDaemonState(statePath: string): DaemonState | null {
  return readJsonFile(statePath, isDaemonState);
}

/**
 * Look up the running daemon's port for a given vault. Returns null when
 * the daemon isn't reachable (no state file, malformed state, or stopped).
 * Honors the dogfood vs production service path via `resolveDaemonServiceState`.
 */
export function readDaemonPort(vaultDir: string, options: ResolveDaemonServiceStateOptions = {}): number | null {
  return readDaemonState(resolveDaemonServiceState(vaultDir, options).statePath)?.port ?? null;
}

export function writeDaemonState(statePath: string, state: DaemonState): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  // 0o700 on the service dir so a same-user attacker can't enumerate
  // `~/.myco/service/` to discover sibling files: intent.update.toml
  // (requested install target), update-error.json (failure detail),
  // logs/ (may include bearer fragments). The 0o600 on daemon.json
  // below protects its bytes; 0o700 on the dir protects directory
  // listing. chmod is unconditional but best-effort — non-POSIX
  // filesystems no-op.
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX; ignore */ }
  // 0o600 because daemon.json carries the daemon-issued bearer token
  // (G4); leaking it would let other local users redirect
  // context-switching requests at any registered Grove. The atomic
  // helper opens the tempfile with O_EXCL and the requested mode so the
  // final path never lands at the default umask.
  atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * SELF_RECONCILE-friendly write: if the on-disk state already matches
 * `expected`, refresh mtime via utimesSync instead of rewriting the file.
 * The mtime is a freshness signal for watchers (and humans) — every tick
 * touches it even when the JSON is identical — but identical content
 * doesn't need a fresh atomic-rename through tmpfile + fsync. Falls back
 * to a full atomic write on any drift or read failure.
 */
export function writeOrTouchDaemonState(statePath: string, expected: DaemonState): void {
  const observed = readDaemonState(statePath);
  if (observed && daemonStateEqual(observed, expected)) {
    try {
      const now = new Date();
      fs.utimesSync(statePath, now, now);
      return;
    } catch {
      // utime failed (deleted under us?) — fall through to full write.
    }
  }
  writeDaemonState(statePath, expected);
}

function daemonStateEqual(a: DaemonState, b: DaemonState): boolean {
  return a.pid === b.pid
    && a.port === b.port
    && (a.command ?? null) === (b.command ?? null)
    && (a.started ?? undefined) === (b.started ?? undefined)
    && (a.version ?? undefined) === (b.version ?? undefined)
    && (a.auth_token ?? undefined) === (b.auth_token ?? undefined)
    && stringArraysEqual(a.sessions, b.sessions);
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function removeDaemonState(statePath: string, ownerPid?: number): void {
  try {
    if (ownerPid !== undefined) {
      const info = readDaemonState(statePath);
      if (info?.pid !== ownerPid) return;
    }
    fs.unlinkSync(statePath);
  } catch {
    // Already gone or unreadable.
  }
}

export function daemonStateMtimeMs(statePath: string): number | null {
  try {
    return fs.statSync(statePath).mtimeMs;
  } catch {
    return null;
  }
}

