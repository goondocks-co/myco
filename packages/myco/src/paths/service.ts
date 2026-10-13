import path from 'node:path';
import { resolveMycoHome } from './home.js';

export const SERVICE_DIRNAME = 'service';
export const DAEMON_STATE_FILENAME = 'daemon.json';

export function resolveServiceDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, SERVICE_DIRNAME);
}

export function resolveServiceDaemonStatePath(mycoHome = resolveMycoHome()): string {
  return path.join(resolveServiceDir(mycoHome), DAEMON_STATE_FILENAME);
}
