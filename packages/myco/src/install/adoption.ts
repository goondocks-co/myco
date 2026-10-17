import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalHomePath, defaultMycoHome } from '@myco/paths/home.js';
import { LifecycleLock, type LockHandle } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { syncDirectoryForDurability } from '@myco/utils/sync-directory.js';
import semver from 'semver';
import { effectiveUpdateChannel } from '@myco/upgrade/check-cache.js';
import { readInstallMarker, writeInstallMarker, type InstallMarker } from './managed-binary.js';
import { validInstallMarker } from './marker-reader.js';
import { isCanonicalCheckoutPath, SOURCE_VERSION_PATTERN } from '../../scripts/install-marker-schema.mjs';
import { atomicWriteFileSync, durableRemovePathSync } from '@myco/utils/atomic-write.js';

export type AdoptionSource = { kind: 'release' } | { kind: 'checkout'; checkout: string; commit: string };
const SOURCE_VERSION = new RegExp(SOURCE_VERSION_PATTERN);
const COMMIT = /^[0-9a-fA-F]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const PUBLICATION_FILE = 'install-adoption.json';
export const RETIRED_BINARY_PREFIX = '.myco-retired-';

export type InstallationLease = { acquired: false } | { acquired: true; release(): void };

/** Serialize every binary publisher with member repair in both selected and default homes. */
export function acquireInstallationLease(home: string, options: { wait?: boolean; timeoutMs?: number | (() => number); command?: string } = {}): InstallationLease {
  const leases: LockHandle[] = [];
  const release = () => { for (const lease of leases.splice(0).reverse()) lease.release(); };
  try {
    for (const lockHome of [...new Set([defaultMycoHome(), home].map(canonicalHomePath))]) {
      const held = LifecycleLock.acquire(path.join(lockHome, 'member', REPAIR_LOCK), {
        wait: options.wait, timeoutMs: typeof options.timeoutMs === 'function' ? options.timeoutMs() : options.timeoutMs,
        command: options.command ?? 'myco binary adoption',
      });
      if (!held.acquired) { release(); return { acquired: false }; }
      leases.push(held.lock);
    }
    return { acquired: true, release };
  } catch (error) { release(); throw error; }
}

export function binarySha256(binary: string): string {
  return createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
}

export function validateSourceIntent(checkout: string, commit: string, version: string): void {
  if (!isCanonicalCheckoutPath(checkout)) throw new Error('Source adoption requires an absolute checkout path without dot segments or a trailing separator.');
  if (COMMIT.exec(commit)?.[0] !== commit) throw new Error('Source adoption requires a full 40-hex commit.');
  if (SOURCE_VERSION.exec(version)?.[0] !== version) throw new Error('Source adoption requires a stamped source build version. Build the candidate first.');
}

/** Only source adoption requires agreement with existing checkout provenance. */
export function assertSourceAdoptionAllowed(home: string, binary: string): void {
  const marker = readInstallMarker(home, true);
  if (marker?.source === 'checkout' && (!fs.existsSync(binary) || binarySha256(binary).toLowerCase() !== marker.binary_sha256.toLowerCase())) {
    throw new Error('The installed source build has changed since installation. Run `myco update` to install a release, then adopt the source build again.');
  }
}

/** Publish provenance from the live, placed and signed executable. */
export function publishAdoptedMarker(home: string, binary: string, version: string, source: AdoptionSource, previous: InstallMarker | null = readInstallMarker(home, true)): InstallMarker {
  if (source.kind === 'checkout') validateSourceIntent(source.checkout, source.commit, version);
  const base = {
    channel: previous?.channel ?? effectiveUpdateChannel(home),
    bin: binary,
    prerelease: semver.prerelease(version) !== null,
    version,
    binary_sha256: binarySha256(binary),
  };
  const marker: InstallMarker = source.kind === 'checkout'
    ? { ...base, source: 'checkout', checkout: source.checkout, commit: source.commit }
    : { ...base, source: previous?.source === 'npm' ? 'npm' : 'curl' };
  writeInstallMarker(home, marker);
  return marker;
}

export function restoreInstallMarker(home: string, previous: InstallMarker | null): void {
  if (previous === null) durableRemovePathSync(path.join(home, 'install.json'));
  else writeInstallMarker(home, previous);
}

export interface BinaryPublication {
  version: 1;
  binary: string;
  previous: string;
  previousHash: string | null;
  marker: InstallMarker | null;
}

/** Persist rollback authority before any live executable rename. */
export function beginBinaryPublication(home: string, binary: string, previous: string): BinaryPublication {
  const publication: BinaryPublication = {
    version: 1, binary, previous,
    previousHash: fs.existsSync(binary) ? binarySha256(binary) : null,
    marker: readInstallMarker(home, true),
  };
  atomicWriteFileSync(path.join(home, PUBLICATION_FILE), JSON.stringify(publication), { durable: true, mode: 0o600 });
  return publication;
}

export function pendingBinaryPublication(home: string, binary: string, previous: string): BinaryPublication | null {
  let publication: BinaryPublication;
  try { publication = JSON.parse(fs.readFileSync(path.join(home, PUBLICATION_FILE), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (publication?.version !== 1 || publication.binary !== binary || publication.previous !== previous
    || !(publication.previousHash === null || (typeof publication.previousHash === 'string' && HASH.exec(publication.previousHash)?.[0] === publication.previousHash))
    || !(publication.marker === null || validInstallMarker(publication.marker))) throw new Error(`Invalid binary publication record at ${path.join(home, PUBLICATION_FILE)}`);
  return publication;
}

export function finishBinaryPublication(home: string): void {
  durableRemovePathSync(path.join(home, PUBLICATION_FILE));
}


/** Recover paired publication under the installation lease before another publisher starts. */
export function recoverInterruptedBinaryPublication(home: string, binary: string, platform: NodeJS.Platform, options: {
  fs?: Pick<typeof fs, 'renameSync' | 'rmSync'>;
  onRetained?: (file: string, reason: string) => void;
} = {}): boolean {
  const previous = path.join(path.dirname(binary), platform === 'win32' ? 'myco.prev.exe' : 'myco.prev');
  const publication = pendingBinaryPublication(home, binary, previous);
  if (publication === null) return false;
  const fileOps = options.fs ?? fs;
  const { previousHash } = publication;
  const alreadyRestored = previousHash !== null && fs.existsSync(binary) && binarySha256(binary) === previousHash;
  if (!alreadyRestored) {
    if (previousHash !== null && (!fs.existsSync(previous) || binarySha256(previous) !== previousHash)) {
      throw new Error(`Cannot recover interrupted update: previous executable at ${previous} does not match. Restore that executable before retrying.`);
    }
    let retired: string | undefined;
    if (fs.existsSync(binary)) {
      if (platform === 'win32') {
        retired = path.join(path.dirname(binary), `${RETIRED_BINARY_PREFIX}${randomUUID()}.exe`);
        fileOps.renameSync(binary, retired);
      } else if (previousHash === null) fileOps.rmSync(binary, { force: true });
    }
    if (previousHash !== null) fileOps.renameSync(previous, binary);
    if (retired !== undefined) {
      try { fileOps.rmSync(retired, { force: true }); }
      catch (error) {
        const reason = `remove ${retired}: ${error instanceof Error ? error.message : String(error)}`;
        if (options.onRetained) options.onRetained(retired, reason); else console.warn(reason);
      }
    }
  }
  syncDirectoryForDurability(path.dirname(binary));
  restoreInstallMarker(home, publication.marker);
  finishBinaryPublication(home);
  return true;
}
