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

/**
 * Brand for the daemon-state file path.
 *
 * Marks the canonical `daemon.json` location as a privileged value:
 * mutations must go through `DaemonStateAuthority`. The brand is
 * structurally a string subtype (so consumers can still read it for
 * logging or pass it to `readDaemonState`), but constructing one
 * requires `resolveDaemonServiceState()` — any direct `fs.unlinkSync`
 * against this value from outside the authority module shows up as an
 * `as string` cast at the call site, making the discipline grep-able.
 */
export type DaemonStatePath = string & { readonly __brand: 'DaemonStatePath' };

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
  /** Canonical `daemon.json` path; branded — mutate only via
   *  `DaemonStateAuthority`. */
  statePath: DaemonStatePath;
  /** `<stateDir>/daemon.lock` — held open by the lifecycle-lock owner
   *  for its entire lifetime. Carries pid+port+authToken once
   *  `server.start()` has bound; readable by hooks as a fallback when
   *  `statePath` is missing. */
  lockPath: string;
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
  const statePath = resolveServiceDaemonStatePath(mycoHome) as DaemonStatePath;
  const stateDir = path.dirname(statePath);
  return {
    scope: 'global',
    stateDir,
    statePath,
    lockPath: path.join(stateDir, 'daemon.lock'),
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

/**
 * Mutation helpers are intentionally NOT exported from this module.
 *
 * `daemon.json` mutations go exclusively through `DaemonStateAuthority`
 * (`./daemon-state-authority.ts`), which:
 *   - encapsulates the path so consumers can't form the unlink argument
 *     against it directly,
 *   - requires a `reason` on every mutation for log observability,
 *   - exposes `replace()` (succession via atomic overwrite) instead of
 *     `delete-then-write`, eliminating the absence window that masked
 *     v0.27.x capture regressions,
 *   - exposes `deleteIfOwnedBy()` as the only conditional deletion path.
 *
 * This file exports only the typed-data helpers needed to construct an
 * authority (`DaemonState`, `readDaemonState`, `daemonStateMtimeMs`) and
 * the service-dir resolution (`resolveDaemonServiceState`).
 */

export function daemonStateMtimeMs(statePath: string): number | null {
  try {
    return fs.statSync(statePath).mtimeMs;
  } catch {
    return null;
  }
}

