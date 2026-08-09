import os from 'node:os';
import path from 'node:path';

/**
 * Env override for the platform-supervisor unit directory.
 *
 * Default behavior: `~/Library/LaunchAgents` on macOS, `~/.config/systemd/user`
 * on Linux. Sandbox/test installs MUST set this to a sandbox-scoped path so
 * `ensureSelfInstalledAsService` (and any other install-time code path)
 * does not write into the real user's LaunchAgents dir and hijack the
 * running daemon's plist.
 */
export const SERVICE_UNIT_DIR_ENV = 'MYCO_LAUNCH_AGENTS_DIR';

export interface ServiceUnitDirOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Resolve the directory where the daemon should write its launchd plist or
 * systemd user-unit file. Honors `MYCO_LAUNCH_AGENTS_DIR` so sandboxed
 * install runs never touch the real `~/Library/LaunchAgents/`.
 */
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

/**
 * Boot-scope (system) supervisor unit directories — where a service installed
 * to run at boot for all users lives, distinct from the per-user dirs
 * `resolveServiceUnitDir` returns. Myco's own daemon is user-scoped, but the
 * retired 1.3.x overlay registered `co.goondocks.myco-headscale` /
 * `-tailscaled` HERE (root, `myco service install` boot mode), so a residue
 * scan that only reads the user scope never sees them on an upgraded host.
 *
 * Returns the platform's system dir(s); empty on Windows (scheduled tasks carry
 * no analogous on-disk unit directory). Not env-overridable — these are fixed
 * OS locations; tests inject them through the caller instead.
 */
export function resolveBootServiceUnitDirs(options: Pick<ServiceUnitDirOptions, 'platform'> = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return ['/Library/LaunchDaemons'];
  if (platform === 'win32') return [];
  return ['/etc/systemd/system'];
}

/**
 * True when the running process is using a sandboxed unit directory rather
 * than the platform default. Drives a suffix on launchd/systemd labels so a
 * sandboxed install cannot collide with the real user's daemon registration
 * in the shared `gui/<uid>` (launchd) or `--user` (systemd) domain — writing
 * the plist into a sandbox dir is not enough on its own, because launchctl
 * still registers the label against the real user's session.
 */
export function isSandboxedServiceUnitDir(options: ServiceUnitDirOptions = {}): boolean {
  const env = options.env ?? process.env;
  return Boolean(env[SERVICE_UNIT_DIR_ENV]?.trim());
}
