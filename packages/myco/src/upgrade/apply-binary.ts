/**
 * Single-binary self-update PRIMITIVE.
 *
 * Replaces the managed `~/.myco/bin/myco` binary in place with a freshly
 * downloaded release asset. This is the riskiest step in the native-installer
 * feature, so the contract is deliberately narrow and the ordering is fixed:
 *
 *   1. DOWNLOAD the asset (to a temp path on the SAME filesystem as the target,
 *      so the final swap is an atomic same-fs rename) and the SHA256SUMS text.
 *   2. VERIFY: look up the asset's expected digest in SHA256SUMS and compare it
 *      (case-insensitively) against the digest of the downloaded bytes.
 *   3. SWAP (only after verify passes): rename the current binary to `<bin>.prev`
 *      (the rollback target), then rename the verified temp file onto `<bin>`.
 *   4. RESTART via the platform ServiceManager (or a direct daemon spawn).
 *   5. AUTO-RESTORE: poll /health; if the new daemon never reaches the target
 *      version within the attempt window, rename `<bin>.prev` back and restart
 *      again so a bad binary can never strand the daemon.
 *
 * Two overriding guarantees, pinned by tests:
 *   - VERIFY BEFORE SWAP. A missing SHA entry, a checksum mismatch, or any
 *     download failure ABORTS before touching `<bin>`: no `<bin>.prev` is
 *     created, the binary is byte-for-byte unchanged, the temp is removed, and
 *     an error side-channel is written.
 *   - THE DAEMON ALWAYS COMES BACK. After a verified swap the function never
 *     returns without the daemon having been (re)started on a binary that is
 *     either the new one (healthy) or the restored prior one. A PRE-SWAP abort
 *     ALSO restarts — but only when NOT service-managed: the caller already
 *     SIGTERM'd this daemon (so a detached respawn can claim the port), and the
 *     untouched `<bin>` is the good binary to respawn on. Under a service
 *     manager the supervisor's KeepAlive/Restart respawns it, so a pre-swap
 *     abort performs NO restart (doing so would race the supervisor).
 *
 * This primitive does NOT resolve the release (channel/version/URLs) — that is
 * the caller's job. It receives already-resolved URLs + the asset name. All
 * I/O (download, hashing, health probe, restart, sleep) is injected so tests
 * run with no network and only their own temp dir.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { UPDATE_ERROR_PATH } from '../constants/update.js';
import { parseSha256Sum } from './release-assets.js';
import { getServiceManager } from '../service/manager.js';
import { clearJsonSentinel } from '../utils/json-sentinel.js';
import { restart, spawnDetached, writeFileSafe, type ApplyUpdateDeps } from './orchestrator.js';
import {
  versionsDir,
  versionDir,
  versionBinaryPath,
  managedBinaryPath,
} from '../install/managed-binary.js';
import type { AssetRefs } from './release-assets.js';

// ---------------------------------------------------------------------------
// Params (resolved by the caller) + deps (injected)
// ---------------------------------------------------------------------------

export interface ApplyBinaryUpdateParams {
  /** Resolved download URL for this platform's asset. */
  assetUrl: string;
  /** Resolved download URL for the release's SHA256SUMS text file. */
  sha256sumsUrl: string;
  /** Asset filename as it appears in SHA256SUMS (e.g. `myco-darwin-arm64`). */
  assetName: string;
  /** Version the new binary is expected to report on /health after restart. */
  targetVersion: string;
  /** The managed binary to replace (`~/.myco/bin/myco`). */
  binaryPath: string;
  /** Canonical daemon port for the post-restart health poll. */
  daemonPort: number;
  /** Service label to restart through, or null when not service-managed. */
  serviceManagedLabel?: string | null;
  /** Project root used for the direct-spawn restart fallback. */
  projectRoot: string;
  /** Max /health polls before declaring the new binary a crash-loop. */
  maxHealthAttempts: number;
  /** Delay between /health polls (ms). */
  healthIntervalMs: number;
  /** Error side-channel path. Defaults to UPDATE_ERROR_PATH; overridable for tests. */
  errorPath?: string;
  /**
   * Absolute path to the `update.in-progress` sentinel the caller wrote before
   * spawning this orchestrator. Cleared here on any abort/restore so a failed
   * self-update never leaves the daemon locked out of future updates for the
   * full 10-minute stale window (the daemon-startup clear only fires when the
   * restarted version matches `targetVersion`, which an aborted/restored daemon
   * does NOT). Optional: when absent the stale-age sweep is the only fallback.
   */
  inProgressSentinelPath?: string | null;
}

/**
 * Deps for the binary swap. Reuses the shared {@link ApplyUpdateDeps} bag
 * (getServiceManager / spawnDetached / probeHealth / sleep — used via the
 * shared `restart`) and adds the two the swap needs.
 */
export interface ApplyBinaryUpdateDeps
  extends Pick<ApplyUpdateDeps, 'getServiceManager' | 'spawnDetached' | 'probeHealth' | 'sleep'> {
  /** Download `url` to `destPath`. Throws on any network/write failure. */
  download: (url: string, destPath: string, headers?: Record<string, string>) => Promise<void>;
  /** Hex SHA-256 of the file at `filePath`. */
  computeSha256: (filePath: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Default (real) implementations
// ---------------------------------------------------------------------------

async function download(
  url: string,
  destPath: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function probeHealth(daemonPort: number): Promise<{ version?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as { version?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_BINARY_UPDATE_DEPS: ApplyBinaryUpdateDeps = {
  getServiceManager,
  // Reached only via the shared `restart` fallback (no service label / a failed
  // service restart); the real cross-platform spawn lives in apply-update.ts.
  spawnDetached,
  probeHealth,
  sleep,
  download,
  computeSha256,
};

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

/**
 * Rename `tmp` onto `target` (`target` is the managed binary, possibly running).
 *
 * POSIX: a plain rename over the inode is safe — a running process keeps its
 * old inode open. Windows: a running `.exe` is locked, so a direct rename can
 * EPERM/EBUSY. The orchestrator runs from a COPY of the running exe (see
 * `resolveOrchestratorBinary` in update-installer.ts:115-132), so the managed
 * binary itself is NOT the running image and the rename normally succeeds; if
 * it is still locked we fall back to copy-over-then-remove. Windows live
 * validation is deferred (see the report's caveat).
 */
function renameBinary(tmp: string, target: string): void {
  if (process.platform !== 'win32') {
    fs.renameSync(tmp, target);
    return;
  }
  try {
    fs.renameSync(tmp, target);
  } catch {
    // Locked target: overwrite in place, then drop the temp. copyFileSync can
    // write over a file whose handle is held even when rename cannot replace it.
    fs.copyFileSync(tmp, target);
    rmSafe(tmp);
  }
}

// ---------------------------------------------------------------------------
// Primitive
// ---------------------------------------------------------------------------

/**
 * Download → verify → swap (`myco.prev`) → restart → crash-loop auto-restore.
 *
 * See the module doc for the full contract. The function is wrapped so it can
 * never throw past its boundary without having attempted to bring the daemon
 * back once a swap has occurred.
 */
export async function applyBinaryUpdate(
  params: ApplyBinaryUpdateParams,
  deps: ApplyBinaryUpdateDeps = DEFAULT_BINARY_UPDATE_DEPS,
): Promise<void> {
  const errorPath = params.errorPath ?? UPDATE_ERROR_PATH;
  const prevPath = `${params.binaryPath}.prev`;
  const dir = path.dirname(params.binaryPath);
  // Same-directory temp paths → the final rename is same-filesystem/atomic.
  const tmpAsset = path.join(dir, `.myco-update-${process.pid}-${Date.now()}.tmp`);
  const tmpSums = path.join(dir, `.myco-update-${process.pid}-${Date.now()}.sha256sums`);

  const writeError = (message: string): void => {
    writeFileSafe(errorPath, JSON.stringify({ error: message }));
  };

  // Clear the caller's `update.in-progress` sentinel. Called on every
  // abort/restore so a failed self-update doesn't lock out future updates for
  // the full 10-minute stale window. The daemon-startup clear only fires when
  // the restarted version matches `targetVersion`, which an aborted/restored
  // daemon does NOT report — so the primitive must drop it here.
  const clearSentinel = (): void => {
    if (params.inProgressSentinelPath) clearJsonSentinel(params.inProgressSentinelPath);
  };

  /**
   * PRE-SWAP abort: the binary is byte-for-byte untouched and no myco.prev was
   * created, so there is nothing to roll back. Record the error and drop the
   * sentinel, then bring the daemon back IFF it is not service-managed:
   *   - Service-managed: the supervisor (launchd KeepAlive / systemd Restart /
   *     Task Scheduler) respawns on its own. Restarting here would race it.
   *   - Non-service: the caller (handleUpdateApply / self-reconcile) already
   *     scheduled THIS daemon's shutdown so the respawn could claim the port —
   *     nothing else will bring it back. `params.binaryPath` is still the
   *     untouched good binary, so a respawn on it is correct.
   */
  const abort = async (message: string): Promise<void> => {
    writeError(message);
    clearSentinel();
    if (!params.serviceManagedLabel) await restartDaemon(params, deps);
  };

  // --- 1 + 2: download and VERIFY, all BEFORE any mutation of binaryPath. ---
  // Any failure here aborts with the binary untouched and no myco.prev created.
  try {
    await deps.download(params.assetUrl, tmpAsset);
    await deps.download(params.sha256sumsUrl, tmpSums);

    const sumsText = fs.readFileSync(tmpSums, 'utf-8');
    const expected = parseSha256Sum(sumsText, params.assetName);
    if (!expected) {
      rmSafe(tmpAsset);
      rmSafe(tmpSums);
      return abort(`SHA256SUMS has no entry for ${params.assetName} — aborting update (binary unchanged)`);
    }

    const actual = await deps.computeSha256(tmpAsset);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      rmSafe(tmpAsset);
      rmSafe(tmpSums);
      return abort(
        `checksum mismatch for ${params.assetName} (expected ${expected}, got ${actual}) — aborting update (binary unchanged)`,
      );
    }
  } catch (err) {
    // Download / read / hash failure → abort. Nothing was swapped.
    rmSafe(tmpAsset);
    rmSafe(tmpSums);
    return abort(`update download/verify failed: ${String(err)} — aborting (binary unchanged)`);
  }

  // The sums file has served its purpose; the asset is verified and trusted.
  rmSafe(tmpSums);

  // --- 3: SWAP. Past this point the daemon MUST be (re)started. ---
  try {
    rmSafe(prevPath); // overwrite any stale rollback target
    fs.renameSync(params.binaryPath, prevPath);
  } catch (err) {
    // Could not stage the rollback target → do NOT swap (we'd lose the only
    // good binary). Abort cleanly; the running daemon is untouched.
    rmSafe(tmpAsset);
    return abort(`could not stage rollback target ${prevPath}: ${String(err)} — aborting (binary unchanged)`);
  }

  try {
    renameBinary(tmpAsset, params.binaryPath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(params.binaryPath, 0o755);
      } catch {
        /* best-effort: keep going, the daemon must still come back */
      }
    }
  } catch (err) {
    // The new binary failed to land but we already moved the old one aside.
    // Restore it immediately so the daemon comes back on the known-good binary.
    rmSafe(tmpAsset);
    try {
      fs.renameSync(prevPath, params.binaryPath);
    } catch {
      /* best-effort */
    }
    writeError(`binary swap failed: ${String(err)} — restored prior binary`);
    // Restored onto the OLD version → the daemon-startup clear won't fire; drop
    // the sentinel here so the next update isn't blocked. The restart is
    // unconditional (post-swap the daemon must always come back); on the service
    // path `restartDaemon` routes through the ServiceManager.
    clearSentinel();
    await restartDaemon(params, deps);
    return;
  }

  // Past the swap the daemon MUST come back. Wrap steps 4-5 so an unexpected
  // throw (a deps bug, an fs error in restore) still ends in a restart attempt.
  try {
    // --- 4: restart onto the new binary. ---
    await restartDaemon(params, deps);

    // --- 5: crash-loop auto-restore. ---
    const healthy = await pollHealthyOnTarget(params, deps);
    if (healthy) {
      // Success: leave myco.prev as the next rollback target; clear the error.
      rmSafe(errorPath);
      return;
    }

    // The new binary never reached the target version → restore + restart again.
    rmSafe(params.binaryPath);
    try {
      fs.renameSync(prevPath, params.binaryPath);
    } catch (restoreErr) {
      /* best-effort: log the failure but proceed to restart on whatever is on disk */
      writeError(`crash-loop restore rename failed: ${String(restoreErr)} — restarting on current disk binary`);
    }
    writeError(
      `new binary ${params.targetVersion} failed to become healthy after ${params.maxHealthAttempts} attempts — rollback to prior binary applied`,
    );
    // Rolled back to the OLD version → the daemon-startup clear won't fire; drop
    // the sentinel so the next update isn't blocked behind a 10-minute window.
    clearSentinel();
    await restartDaemon(params, deps);
  } catch (err) {
    // Last resort: record the failure and make one final restart attempt so the
    // daemon is never stranded, whatever binary is currently on disk.
    writeError(`apply-binary-update post-swap recovery failed: ${String(err)}`);
    try {
      await restartDaemon(params, deps);
    } catch {
      /* nothing more we can do */
    }
  }
}

/** Restart via the shared cross-platform restart (ServiceManager or direct spawn). */
async function restartDaemon(
  params: ApplyBinaryUpdateParams,
  deps: ApplyBinaryUpdateDeps,
): Promise<void> {
  // `restart` only uses getServiceManager / spawnDetached from the bag.
  await restart(
    deps as unknown as ApplyUpdateDeps,
    params.serviceManagedLabel,
    params.binaryPath,
    params.projectRoot,
  );
}

/**
 * Poll /health up to `maxHealthAttempts` times (spaced by `healthIntervalMs`),
 * returning true as soon as the daemon reports the target version.
 */
async function pollHealthyOnTarget(
  params: ApplyBinaryUpdateParams,
  deps: ApplyBinaryUpdateDeps,
): Promise<boolean> {
  for (let attempt = 0; attempt < params.maxHealthAttempts; attempt += 1) {
    if (attempt > 0) await deps.sleep(params.healthIntervalMs);
    try {
      const body = await deps.probeHealth(params.daemonPort);
      if (body && body.version === params.targetVersion) return true;
    } catch {
      /* probe failure counts as not-yet-healthy */
    }
  }
  return false;
}

// ===========================================================================
// Task 4: stage → versioned-dir + copy-on-adopt + retention/restore
// ===========================================================================

// ---------------------------------------------------------------------------
// stageBinary deps (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Deps for `stageBinary`. Reuses the download/computeSha256 pair already
 * defined on `ApplyBinaryUpdateDeps` so the same dep bag can cover both the
 * legacy `applyBinaryUpdate` and the new staged primitives.
 */
export interface StageBinaryDeps {
  /** Download `url` to `destPath`. Throws on any network/write failure. */
  download: (url: string, destPath: string, headers?: Record<string, string>) => Promise<void>;
  /** Hex SHA-256 of the file at `filePath`. */
  computeSha256: (filePath: string) => Promise<string>;
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

  // --- 3: RENAME verified temp into versions/<v>/ (atomic, same fs) ---
  // Only now do we create the version-specific directory.
  try {
    fs.mkdirSync(vDir, { recursive: true });
    fs.renameSync(tempPath, vBinPath);
    if (platform !== 'win32') {
      try {
        fs.chmodSync(vBinPath, 0o755);
      } catch {
        /* best-effort: keep going */
      }
    }
  } catch (err) {
    rmSafe(tempPath);
    // If we created the version dir but the rename failed, clean it up so
    // nothing half-lands under versions/<v>/.
    try { fs.rmSync(vDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return {
      error: `could not stage binary to ${vBinPath}: ${String(err)} — staging aborted (stable binary untouched)`,
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
 * Copy the versioned binary into the managed path atomically (temp+rename,
 * same fs; `chmod 0o755` on non-win32).
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
  },
  _deps: AdoptStagedDeps = {},
): Promise<void> {
  const { home, platform, version, localAppData } = params;

  const src = versionBinaryPath(home, platform, version, localAppData);
  const dest = managedBinaryPath(home, platform, localAppData);
  const destDir = path.dirname(dest);
  const tmp = path.join(destDir, `.myco-adopt-${process.pid}-${Date.now()}.tmp`);

  fs.mkdirSync(destDir, { recursive: true });

  // Copy src → temp in the same dir as dest (same filesystem → rename is atomic).
  fs.copyFileSync(src, tmp);

  // On non-win32, chmod must succeed: a 0644 binary from copyFileSync cannot
  // be exec'd by the daemon. If chmod fails, clean the tmp and rethrow so
  // Task 5 can restore rather than adopting a non-executable binary.
  if (platform !== 'win32') {
    try {
      fs.chmodSync(tmp, 0o755);
    } catch (chmodErr) {
      rmSafe(tmp);
      throw chmodErr;
    }
  }

  // Atomic rename over the managed binary.
  // If rename fails, clean the tmp (managed binary is untouched) and rethrow.
  try {
    fs.renameSync(tmp, dest);
  } catch (renameErr) {
    rmSafe(tmp);
    throw renameErr;
  }
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
  const src = versionBinaryPath(home, platform, version, localAppData);
  const dest = managedBinaryPath(home, platform, localAppData);
  const destDir = path.dirname(dest);
  const tmp = path.join(destDir, `.myco-restore-${process.pid}-${Date.now()}.tmp`);

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, tmp);

  // On non-win32, chmod must succeed (same rationale as adoptStaged).
  if (platform !== 'win32') {
    try {
      fs.chmodSync(tmp, 0o755);
    } catch (chmodErr) {
      rmSafe(tmp);
      throw chmodErr;
    }
  }

  // Rename failure cleans the tmp and rethrows; managed binary is untouched.
  try {
    fs.renameSync(tmp, dest);
  } catch (renameErr) {
    rmSafe(tmp);
    throw renameErr;
  }
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
