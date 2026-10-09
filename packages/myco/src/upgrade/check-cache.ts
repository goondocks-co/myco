/** The shared release-check cache; doctor reads it without release-network traffic. */
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readInstallMarker } from '../install/managed-binary.js';
import type { ReleaseChannel } from '../constants/update.js';

export const CACHE_FILENAME = 'last-update-check.json';
const NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function writeReleaseCheckCache(home: string, value: unknown): void {
  fs.mkdirSync(home, { recursive: true });
  atomicWriteFileSync(path.join(home, CACHE_FILENAME), JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function recordUpdateCheck(home: string, channel: ReleaseChannel, current: string, latest: string | null): void {
  writeReleaseCheckCache(home, {
    checked_at: new Date().toISOString(), channel,
    packages: { myco: { package_name: '@goondocks/myco', latest_version: latest ?? current,
      latest_stable: channel === 'stable' ? latest ?? current : current, latest_beta: channel === 'beta' ? latest : null } },
  });
}

export function readUpdateNotice(home: string, current: string, now = Date.now(), configuredChannel?: ReleaseChannel): string | null {
  let value: { checked_at?: string; channel?: ReleaseChannel; packages?: { myco?: { latest_version?: string; latest_stable?: string; latest_beta?: string | null } } };
  try { value = JSON.parse(fs.readFileSync(path.join(home, CACHE_FILENAME), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'Release check cache is unreadable; run `myco update --check`.';
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const channel = configuredChannel ?? readInstallMarker(home, true)?.channel ?? 'stable';
  const checked = Date.parse(value.checked_at ?? '');
  if (value.channel !== channel || !Number.isFinite(checked) || now < checked || now - checked > NOTICE_MAX_AGE_MS) return null;
  const row = value.packages?.myco;
  const latest = row?.latest_version ?? (channel === 'beta' ? row?.latest_beta ?? row?.latest_stable : row?.latest_stable);
  if (!latest || !semver.valid(latest) || !semver.valid(current) || !semver.gt(latest, current)) return null;
  return `Myco ${latest} is available on channel ${channel} (checked ${value.checked_at}); run \`myco update\`.`;
}
