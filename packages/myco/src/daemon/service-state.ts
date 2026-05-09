import fs from 'node:fs';
import path from 'node:path';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import {
  DAEMON_STATE_FILENAME,
  resolveMycoHome,
  resolveServiceDaemonStatePath,
  resolveServiceDir,
} from '@myco/grove/paths.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import { derivePort } from './port.js';

export type DaemonServiceScope = 'global' | 'legacy-project';

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
  if (usesGlobalDaemon(vaultDir, options)) {
    const mycoHome = resolveMycoHome({ env: options.env as NodeJS.ProcessEnv | undefined });
    const statePath = resolveServiceDaemonStatePath(mycoHome);
    return {
      scope: 'global',
      stateDir: path.dirname(statePath),
      statePath,
      canonicalPort: resolveGlobalDaemonPort(mycoHome),
    };
  }

  return {
    scope: 'legacy-project',
    stateDir: vaultDir,
    statePath: path.join(vaultDir, DAEMON_STATE_FILENAME),
    canonicalPort: derivePort(vaultDir),
  };
}

export function resolveDaemonLogDir(
  vaultDir: string,
  options: ResolveDaemonServiceStateOptions = {},
): string {
  return path.join(resolveDaemonServiceState(vaultDir, options).stateDir, 'logs');
}

export function readDaemonState(statePath: string): DaemonState | null {
  try {
    const info = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<DaemonState>;
    if (typeof info.pid !== 'number' || typeof info.port !== 'number') return null;
    return info as DaemonState;
  } catch {
    return null;
  }
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
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // 0o600 because daemon.json now carries the daemon-issued bearer
  // token (G4); leaking it would let other local users redirect
  // context-switching requests at any registered Grove.
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {
    // Best-effort; non-POSIX filesystems and read-only mounts.
  }
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

function usesGlobalDaemon(
  vaultDir: string,
  options: ResolveDaemonServiceStateOptions,
): boolean {
  if (options.requestContext?.groveId) return true;

  try {
    const manifest = loadProjectManifest(vaultDir);
    return Boolean(manifest?.grove?.binding_id);
  } catch {
    return false;
  }
}
