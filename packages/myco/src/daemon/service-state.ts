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

export function writeDaemonState(statePath: string, state: DaemonState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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
