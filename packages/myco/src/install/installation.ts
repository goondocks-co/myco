import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readInstallMarker } from './marker-reader.js';
import { isDevelopmentVersion } from '../../scripts/release-policy.mjs';
import { getPluginVersion } from '../version.js';

export const SOURCE_BUILD_REASON = 'this is a source build';
const SHORT_COMMIT_LENGTH = 8;

export interface Installation {
  source: 'checkout' | 'curl' | 'npm' | 'unknown';
  version: string;
  checkout: string | null;
  commit: string | null;
  record: 'matching' | 'mismatch' | 'unverified' | 'absent' | 'unreadable';
  detail: string;
  status: 'ok' | 'warn';
}

const canonicalBinary = (file: string): string => {
  try { return fs.realpathSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return path.resolve(file); }
};

/** Project installation provenance against the bytes being inspected. */
export function readInstallation(home: string, version = getPluginVersion(), binary = process.execPath): Installation {
  let marker: ReturnType<typeof readInstallMarker> = null;
  let record: Installation['record'] = 'absent';
  try { marker = readInstallMarker(home, true); }
  catch { record = 'unreadable'; }
  if (marker !== null) {
    record = 'unverified';
    try {
      if (canonicalBinary(marker.bin) !== canonicalBinary(binary)) record = 'mismatch';
      else if (typeof marker.binary_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(marker.binary_sha256)) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
        record = digest === marker.binary_sha256.toLowerCase() ? 'matching' : 'mismatch';
      }
    } catch { record = 'unreadable'; }
    const staleVersion = marker.version !== undefined && marker.version !== version;
    if (staleVersion && record !== 'unreadable') record = 'mismatch';
  }
  const source = isDevelopmentVersion(version) ? 'checkout' : marker?.source === 'checkout' ? 'unknown' : marker?.source ?? 'unknown';
  const checkoutMarker = marker?.source === 'checkout' && record === 'matching' ? marker : null;
  const checkout = checkoutMarker?.checkout ?? null;
  const commit = checkoutMarker?.commit ?? null;
  const detail = marker?.source === 'checkout' && record === 'mismatch'
    ? `This binary does not match the installed source build. Run \`make source-install\` in ${marker.checkout} on the macOS/Linux build machine; on Windows, install its cross-built artifact. Running \`myco update\` instead installs the selected channel release.`
    : source === 'checkout'
      ? checkoutMarker !== null ? `Source build from ${checkoutMarker.checkout}, commit ${checkoutMarker.commit.slice(0, SHORT_COMMIT_LENGTH)}` : `Source build ${version} (origin unknown)`
      : `${version}${source === 'unknown' ? ' (origin unknown)' : ''}`;
  const status = record === 'unreadable'
    || (marker?.source === 'checkout' && record !== 'matching') ? 'warn' : 'ok';
  return { source, version, checkout, commit, record, status,
    detail: record === 'unreadable' && status === 'warn' ? `${detail}; could not inspect this installation` : detail };
}
