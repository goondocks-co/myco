import fs from 'node:fs';
import path from 'node:path';
import { derivePort } from '@myco/paths/ports.js';
import YAML from 'yaml';
import { readJsonFile } from '@goondocks/myco-shared/json';
import { resolveMycoHome } from '@myco/paths/home.js';
import { resolveServiceDir } from '@myco/paths/service.js';

export interface DaemonState {
  pid: number;
  port: number;
  command?: string | null;
  started?: string;
  sessions?: string[];
  version?: string;
  /** The daemon-issued bearer for authenticated local requests. */
  auth_token?: string;
}

/** The home's explicit daemon port, or null for absent, unreadable or invalid configuration. */
function readDaemonPortOverride(mycoHome: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(mycoHome, 'config.yaml'), 'utf-8');
    const doc = YAML.parse(raw) as { daemon?: { port?: unknown } } | null;
    const port = doc?.daemon?.port;
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535) {
      return port;
    }
  } catch {
    /* missing / malformed config.yaml — fall back to the derived port */
  }
  return null;
}

/**
 * The daemon's binding port: `daemon.port` from `<mycoHome>/config.yaml` if
 * set, else `derivePort(resolveServiceDir(mycoHome))`. All consumers resolve
 * the port through this function.
 */
export function resolveGlobalDaemonPort(mycoHome = resolveMycoHome()): number {
  return readDaemonPortOverride(mycoHome) ?? derivePort(resolveServiceDir(mycoHome));
}

function isDaemonState(value: unknown): value is DaemonState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DaemonState>;
  return typeof v.pid === 'number' && typeof v.port === 'number';
}

export function readDaemonState(statePath: string): DaemonState | null {
  return readJsonFile(statePath, isDaemonState);
}
