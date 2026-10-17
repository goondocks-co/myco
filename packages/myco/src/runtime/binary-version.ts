import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { isDevelopmentVersion } from '../../scripts/release-policy.mjs';

export const LIVE_MEMBER_VERSION_TIMEOUT_MS = 2_000;

/** Read an executable's reported version within the caller's probe budget. */
export function readBinaryVersion(binary: string, timeoutMs: number): string {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`version check exited ${result.status}${result.signal ? ` (${result.signal})` : ''}`);
  return result.stdout.trim();
}

/** An installed source identity supersedes every different process identity. */
export function installedVersionSupersedes(live: string, running: string): boolean {
  if (!semver.valid(live) || !semver.valid(running)) return false;
  if (isDevelopmentVersion(live) || isDevelopmentVersion(running)) return live !== running;
  return semver.gt(live, running);
}
