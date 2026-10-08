/**
 * The self-update binary primitives: download and verify a release asset into
 * its versioned slot (`stageBinary`), put a staged version on the managed path
 * (`adoptStaged`), put a prior version back (`restoreVersion`), and retire old
 * slots (`pruneVersions`). Every write of a binary goes through
 * `placeExecutable`, which swaps a synced temporary file in by one rename; a
 * download is staged only once it verifies against SHA256SUMS and runs on this
 * machine. The orchestrator (`orchestrator.ts`) owns stop, adopt, restart,
 * health watch and restore.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSha256Sum } from './release-assets.js';
import {
  versionsDir,
  versionDir,
  versionBinaryPath,
  managedBinaryPath,
} from '../install/managed-binary.js';
import type { AssetRefs } from './release-assets.js';
import { placeExecutable, readyExecutable, type ProgramProbe } from '../install/place-binary.js';

// ---------------------------------------------------------------------------
// Download size cap (DoS / availability guard)
// ---------------------------------------------------------------------------

/**
 * Maximum bytes accepted per binary download. A compromised or misconfigured
 * CDN returning a huge body would otherwise OOM the orchestrator — this cap
 * makes that impossible. Set well above the largest expected myco binary
 * (~17 MB) to allow plenty of growth headroom while still bounding memory
 * exposure. This is NOT an integrity check; sha256 verify-before-place covers
 * that. Integrity: sha256. Availability: this cap.
 */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024; // 256 MiB

// ---------------------------------------------------------------------------
// Default (real) implementations
// ---------------------------------------------------------------------------

async function download(
  url: string,
  destPath: string,
  headers: Record<string, string>,
  maxBytes: number,
): Promise<void> {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  }

  // Early-reject: if Content-Length is present and already exceeds the cap,
  // refuse before reading a single byte. Content-Length can lie, so the
  // streaming byte-count below is ALWAYS enforced regardless.
  const contentLength = res.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new Error(
        `download refused: Content-Length ${declared} exceeds cap of ${maxBytes} bytes (${url})`,
      );
    }
  }

  if (!res.body) {
    throw new Error(`download failed: response body is null (${url})`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Stream response body to disk with a running byte counter. If the counter
  // exceeds the cap the stream is aborted, the partial file is deleted, and a
  // clear error is thrown — the caller's temp-cleanup path handles the rest.
  // This prevents an oversized (or malicious) CDN response from OOM-ing the
  // orchestrator even when Content-Length is absent or lying.
  let received = 0;
  const fileStream = fs.createWriteStream(destPath);
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        reader.cancel().catch(() => { /* best-effort cancel */ });
        fileStream.destroy();
        rmSafe(destPath);
        throw new Error(
          `download exceeded ${maxBytes} bytes (cap) — aborting to prevent OOM (${url})`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // On any error (cap exceeded, write failure, …) ensure the file stream is
    // closed and the partial file is removed before re-throwing.
    fileStream.destroy();
    rmSafe(destPath);
    throw err;
  }
}

function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Options for `createBinaryUpdateDeps`. */
export interface BinaryUpdateDepsOptions {
  /** Byte cap on one download. Defaults to `MAX_DOWNLOAD_BYTES`. */
  maxDownloadBytes?: number;
}

/** The real download and hash for `stageBinary`, with the download capped at `maxDownloadBytes`. */
export function createBinaryUpdateDeps(options: BinaryUpdateDepsOptions = {}): StageBinaryDeps {
  const maxBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  return {
    download: (url, destPath, headers = {}) => download(url, destPath, headers, maxBytes),
    computeSha256,
  };
}

/** The real download and hash for `stageBinary`, capped at `MAX_DOWNLOAD_BYTES`. */
export const DEFAULT_BINARY_UPDATE_DEPS: StageBinaryDeps = createBinaryUpdateDeps();

// ---------------------------------------------------------------------------
// Filesystem helpers (cross-platform — no shell)
// ---------------------------------------------------------------------------

function rmSafe(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* best-effort */
  }
}

// ===========================================================================
// Task 4: stage → versioned-dir + copy-on-adopt + retention/restore
// ===========================================================================

// ---------------------------------------------------------------------------
// stageBinary deps (injectable for tests)
// ---------------------------------------------------------------------------

/** Deps for `stageBinary`: the download, the hash, and the runnable check. */
export interface StageBinaryDeps {
  /** Download `url` to `destPath`. Throws on any network/write failure. */
  download: (url: string, destPath: string, headers?: Record<string, string>) => Promise<void>;
  /** Hex SHA-256 of the file at `filePath`. */
  computeSha256: (filePath: string) => Promise<string>;
  /** Whether a verified download runs on this machine. Defaults to `readyExecutable`. */
  ready?: (filePath: string) => ProgramProbe;
}

/** Result of a successful `stageBinary`. */
export interface StageBinarySuccess {
  /** The version directory (`<bindir>/versions/<version>`). */
  versionDir: string;
  /** The semver version string (tag suffix from `AssetRefs.targetVersion`). */
  version: string;
}

/** Result of a failed `stageBinary`. */
export interface StageBinaryError {
  error: string;
}

export type StageBinaryResult = StageBinarySuccess | StageBinaryError;

/**
 * Download and verify a new release asset into the versioned-dir layout.
 *
 * CONTRACT (failure invariant):
 *   - Download to a temp path INSIDE `versions/` (same filesystem as
 *     `versions/<v>/`) so the final rename is atomic.
 *   - Verify sha256 BEFORE any rename into `versions/<v>/`.
 *   - On ANY failure (download throws / missing SHA entry / checksum mismatch):
 *       - delete the temp file
 *       - return `{ error }` — nothing lands under `versions/<v>/`
 *       - the stable managed binary (`~/.myco/bin/myco`) is NEVER touched
 *   - On success: rename verified temp → `versionBinaryPath`; return `{ versionDir, version }`.
 *
 * Task 5 owns stop → adopt → start → health-watch → restore-on-crash.
 * This primitive is ONLY the download+verify+stage step.
 */
export async function stageBinary(
  params: {
    refs: AssetRefs;
    home: string;
    platform: NodeJS.Platform;
    localAppData?: string;
  },
  deps: StageBinaryDeps,
): Promise<StageBinaryResult> {
  const { refs, home, platform, localAppData } = params;
  const { targetVersion } = refs;

  // Compute the destination paths using the Task 3 helpers.
  const vDir = versionDir(home, platform, targetVersion, localAppData);
  const vBinPath = versionBinaryPath(home, platform, targetVersion, localAppData);
  const vDir2 = versionsDir(home, platform, localAppData);

  // Temp file inside `versions/` so the final rename is same-fs/atomic.
  // Use the versions parent dir (NOT the version-specific subdir) so the
  // temp is always on the same fs but we write nothing into `versions/<v>/`
  // until verification passes.
  const tempPath = path.join(vDir2, `.myco-stage-${process.pid}-${Date.now()}.tmp`);
  const tempSums = path.join(vDir2, `.myco-stage-${process.pid}-${Date.now()}.sha256sums`);

  // Ensure the versions dir exists (version-specific dir is created after verify).
  try {
    fs.mkdirSync(vDir2, { recursive: true });
  } catch (err) {
    return { error: `could not create versions dir ${vDir2}: ${String(err)}` };
  }

  // --- 1 + 2: download and VERIFY, all BEFORE creating versions/<v>/ ---
  try {
    await deps.download(refs.assetUrl, tempPath);
    await deps.download(refs.sha256sumsUrl, tempSums);

    const sumsText = fs.readFileSync(tempSums, 'utf-8');
    const expected = parseSha256Sum(sumsText, refs.assetName);
    if (!expected) {
      rmSafe(tempPath);
      rmSafe(tempSums);
      return {
        error: `SHA256SUMS has no entry for ${refs.assetName} — staging aborted (stable binary untouched)`,
      };
    }

    const actual = await deps.computeSha256(tempPath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      rmSafe(tempPath);
      rmSafe(tempSums);
      return {
        error: `checksum mismatch for ${refs.assetName} (expected ${expected}, got ${actual}) — staging aborted (stable binary untouched)`,
      };
    }
  } catch (err) {
    rmSafe(tempPath);
    rmSafe(tempSums);
    return {
      error: `stage download/verify failed: ${String(err)} — staging aborted (stable binary untouched)`,
    };
  }

  // Sums file served its purpose.
  rmSafe(tempSums);

  // --- 3: PLACE the verified temp into versions/<v>/, once it runs here ---
  // Only now do we create the version-specific directory.
  try {
    placeExecutable(tempPath, vBinPath, {
      platform,
      move: true,
      ready: deps.ready ?? ((file) => readyExecutable(file, platform)),
    });
  } catch (err) {
    rmSafe(tempPath);
    // If we created the version dir but the placement failed, clean it up so
    // nothing half-lands under versions/<v>/.
    try { fs.rmSync(vDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return {
      error: `could not stage binary to ${vBinPath}: ${err instanceof Error ? err.message : String(err)} — staging aborted (stable binary untouched)`,
    };
  }

  return { versionDir: vDir, version: targetVersion };
}

// ---------------------------------------------------------------------------
// adoptStaged deps
// ---------------------------------------------------------------------------

/**
 * Deps for `adoptStaged` (injectable for tests — no real fs ops needed in the
 * test environment beyond what the test directly writes).
 */
export interface AdoptStagedDeps {
  /** Hex SHA-256 of the file at `filePath` (kept symmetric with stageBinary). */
  computeSha256?: (filePath: string) => Promise<string>;
}

/**
 * Copy the versioned binary into the managed path atomically through
 * `placeExecutable` (temp beside it, synced, `chmod 0o755` on non-win32, one
 * rename). The bytes were judged runnable when they were staged.
 *
 * CONTRACT:
 *   - Assumes the daemon is ALREADY stopped (Task 5 owns the stop).
 *   - Retains the version dir (so `restoreVersion` can use it).
 *   - Atomic: copy to a temp in the managed bin dir, then rename over the
 *     managed binary (same filesystem as `~/.myco/bin/`) so there is no
 *     window where the managed binary is absent.
 *   - On non-win32, chmod failure is FATAL (not best-effort): a non-executable
 *     managed binary would silently break daemon restarts. The tmp is cleaned
 *     and the error is rethrown so Task 5 can restore.
 *   - On win32, executability is not mode-based; chmod is skipped entirely.
 *
 * Throws on any fs failure (the caller — Task 5 — must handle this and
 * restore if needed).
 */
export async function adoptStaged(
  params: {
    home: string;
    platform: NodeJS.Platform;
    version: string;
    localAppData?: string;
    destination?: string;
  },
  _deps: AdoptStagedDeps = {},
): Promise<void> {
  const { home, platform, version, localAppData } = params;

  placeExecutable(
    versionBinaryPath(home, platform, version, localAppData),
    params.destination ?? managedBinaryPath(home, platform, localAppData),
    { platform },
  );
}

// ---------------------------------------------------------------------------
// restoreVersion
// ---------------------------------------------------------------------------

/**
 * Copy the versioned binary for `version` back onto the managed binary path.
 *
 * This is the COPY-BACK primitive. Task 5 owns the daemon restart after a
 * restore. No cleanup of the version dir — the caller decides retention.
 *
 * Uses the same temp+rename approach as `adoptStaged` to keep the managed
 * binary never-absent during the restore. Same chmod and rename-failure
 * semantics as `adoptStaged`: on non-win32, chmod failure is fatal (tmp
 * cleaned, error rethrown); rename failure likewise cleans tmp and rethrows.
 */
export async function restoreVersion(
  home: string,
  platform: NodeJS.Platform,
  version: string,
  localAppData?: string,
): Promise<void> {
  placeExecutable(
    versionBinaryPath(home, platform, version, localAppData),
    managedBinaryPath(home, platform, localAppData),
    { platform },
  );
}

// ---------------------------------------------------------------------------
// pruneVersions
// ---------------------------------------------------------------------------

/**
 * Remove old version directories, keeping at most `max(keep, 2)` total
 * (the floor protects current + previous from ever being pruned).
 *
 * INVARIANTS:
 *   - NEVER removes the `current` or `previous` version dir, even if keep < 2.
 *   - `current` is REQUIRED (the running version). Omitting it is a type error.
 *     This prevents the rollback-scenario foot-gun: during a rollback the
 *     running version is NOT the newest, so deriving current from semver order
 *     alone could delete the live version and make restoreVersion impossible.
 *   - `previous` is derived automatically (next-newest version strictly below
 *     `current` by semver, if any). It can also be overridden by the caller.
 *   - `keep` is floored at 2 (so `pruneVersions(…, 1)` behaves like `keep=2`).
 *   - Prunes the OLDEST versions (by semver) first so the most recent versions
 *     are always kept.
 *   - If the versions directory does not exist, returns without error.
 *   - Version dirs that are not valid semver are skipped (never removed by prune).
 *
 * @param home        Myco home directory (e.g. `~/.myco`).
 * @param platform    Target platform.
 * @param keep        Number of versions to keep total (floored at 2). Default 3.
 * @param current     REQUIRED: the currently-running version (never pruned).
 * @param previous    The previous version kept as rollback target (never pruned).
 *                    Defaults to the next-newest version strictly below `current`.
 * @param localAppData  Only used on win32.
 */
export function pruneVersions(
  home: string,
  platform: NodeJS.Platform,
  keep = 3,
  current: string,
  previous?: string,
  localAppData?: string,
): void {
  const effectiveKeep = Math.max(keep, 2);
  const vDir = versionsDir(home, platform, localAppData);

  // If versions directory doesn't exist, nothing to do.
  if (!fs.existsSync(vDir)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(vDir);
  } catch {
    return;
  }

  // Collect only directories with valid semver names, sorted newest-first.
  const semverRe = /^\d+\.\d+\.\d+/;
  const versions = entries
    .filter((entry) => {
      if (!semverRe.test(entry)) return false;
      try {
        return fs.statSync(path.join(vDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      // Sort newest-first using simple semver tuple comparison.
      return compareSemverStrings(b, a);
    });

  // If there is only one version and it is current, nothing to prune.
  if (versions.length <= 1) return;

  // Derive `previous` if not supplied: next-newest version strictly below
  // `current` by semver. This is safe even during rollback (current may be
  // older than a newer staged version — we still protect it and its predecessor).
  const effectivePrevious =
    previous ??
    versions.find((v) => compareSemverStrings(v, current) < 0) ??
    undefined;

  // Build the protected set: current + previous (if any).
  const protectedSet = new Set<string>();
  protectedSet.add(current);
  if (effectivePrevious) protectedSet.add(effectivePrevious);

  // Fill keep slots from the newest versions first; protected are always included.
  const keepSet = new Set<string>(protectedSet);
  for (const ver of versions) {
    if (keepSet.size >= effectiveKeep) break;
    keepSet.add(ver);
  }

  if (versions.length <= keepSet.size) return;

  for (const ver of versions) {
    if (keepSet.has(ver)) continue;
    // Prune this version dir.
    try {
      fs.rmSync(path.join(vDir, ver), { recursive: true, force: true });
    } catch {
      /* best-effort: if we can't remove, skip it */
    }
  }
}

// ---------------------------------------------------------------------------
// Semver comparison helper (no semver dep — operates on string triplets)
// ---------------------------------------------------------------------------

function parseSemverTuple(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverStrings(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemverTuple(a);
  const [bMaj, bMin, bPat] = parseSemverTuple(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}
