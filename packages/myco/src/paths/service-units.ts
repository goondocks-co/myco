/** Platform paths for on-disk service units. */
import os from 'node:os';
import path from 'node:path';

export const SERVICE_UNIT_DIR_ENV = 'MYCO_LAUNCH_AGENTS_DIR';

export interface ServiceUnitDirOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function resolveServiceUnitDir(options: ServiceUnitDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const override = env[SERVICE_UNIT_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'LaunchAgents');
  if (platform === 'win32') return path.join(homeDir, '.myco', 'service');
  return path.join(homeDir, '.config', 'systemd', 'user');
}

export function resolveBootServiceUnitDirs(options: Pick<ServiceUnitDirOptions, 'platform'> = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return ['/Library/LaunchDaemons'];
  if (platform === 'win32') return [];
  return ['/etc/systemd/system'];
}

export function isSandboxedServiceUnitDir(options: ServiceUnitDirOptions = {}): boolean {
  const env = options.env ?? process.env;
  return Boolean(env[SERVICE_UNIT_DIR_ENV]?.trim());
}
