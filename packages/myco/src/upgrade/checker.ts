/**
 * Myco/GitHub version checker — resolves the `myco` package check row from
 * GitHub Releases.
 *
 * Responsibility boundary: ONLY the myco package, ONLY from GitHub Releases.
 * No npm-registry calls, no operator-CLI concerns.
 *
 * Exports:
 *   resolveMycoPackageCheck(...)  — fetch GitHub Releases + derive PackageCheckResult for myco
 */

import { isV2Version } from '../../scripts/release-policy.mjs';

import type { FetchLike } from '../utils/instrumented-fetch.js';
import {
  resolveMycoVersions,
  pickRelease,
  assetName,
  resolveTargetTriple,
  type GitHubRelease,
} from './release-assets.js';
import type { ReleaseChannel, UpdatePackageId } from '../constants/update.js';
import { NPM_PACKAGE_NAME } from '../constants/update.js';
import semver from 'semver';
import { fetchMycoReleases } from './release-resolver.js';

// ---------------------------------------------------------------------------
// Public types (re-exported for consumer convenience)
// ---------------------------------------------------------------------------

/** Installed/update status for one globally installed Myco package. */
export interface PackageCheckResult {
  id: UpdatePackageId;
  display_name: string;
  package_name: string;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  latest_stable: string | null;
  latest_beta: string | null;
  /** True when the target version is strictly greater than what's installed. */
  update_available: boolean;
  /**
   * True when the desired channel is `stable`, the running binary is a
   * prerelease, and a stable target exists — i.e. a beta user can step back
   * onto the stable release. Set only on the `myco` package; mutually
   * exclusive with `update_available`. Derived from the running version +
   * desired channel (the robust primary signal), corroborated by the install
   * marker when present — NOT from the retired managed-runtime pin.
   */
  revert_available: boolean;
  /** An eligible remote release is older than this running build. */
  staying_put?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `version` carries a semver prerelease component (e.g. a `-beta.N`
 * suffix). The robust primary signal that the running myco binary is a beta.
 */
function isPrerelease(version: string): boolean {
  return semver.valid(version) !== null && semver.prerelease(version) !== null;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Fetch GitHub Releases for myco and derive a `PackageCheckResult` row.
 *
 * - `currentVersion`   — the version of the currently-running myco binary
 * - `channel`          — effective release channel (stable | beta)
 * - `installedVersion` — version read from the global npm install (may differ
 *                        from the running binary for the managed-binary path)
 * - `fetchFn`          — injectable fetch (defaults to global fetch; tests mock it)
 *
 * Returns the raw `PackageCheckResult` for the `myco` package. The caller
 * (shim or Task 7 api/upgrade.ts) assembles the composite CheckResult.
 *
 * On network/HTTP failure, throws so the caller's Promise.allSettled can
 * collect the rejection and fall back to cached data.
 */
export async function resolveMycoPackageCheck(
  currentVersion: string,
  channel: ReleaseChannel,
  installedVersion: string | null,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<PackageCheckResult> {
  const releases = await fetchMycoReleases(fetchFn);
  const isV2 = isV2Version(currentVersion);
  const lineReleases = isV2 ? releases : releases.filter(r => (semver.parse(r.tag_name.replace(/^myco\/v/, ''))?.major ?? 0) < 2);
  if (isV2) {
    const asset = assetName(resolveTargetTriple());
    const version = (r: GitHubRelease | null) => r?.tag_name.slice(6) ?? null;
    const latestStable = version(pickRelease(lineReleases, 'stable', { minimumMajor: 2, asset }));
    const latestBeta = version(pickRelease(lineReleases, 'beta', { minimumMajor: 2, asset }));
    const candidate = version(pickRelease(lineReleases, channel, { minimumMajor: 2, asset }));
    const target = version(pickRelease(lineReleases, channel, { minimumMajor: 2, asset, currentVersion }));
    return {
      id: 'myco', display_name: 'Myco', package_name: NPM_PACKAGE_NAME,
      installed: installedVersion !== null, installed_version: installedVersion,
      latest_version: target ?? currentVersion, latest_stable: latestStable, latest_beta: latestBeta,
      update_available: installedVersion !== null && target !== null && semver.gt(target, currentVersion)
        && semver.valid(installedVersion) !== null && semver.gt(target, installedVersion),
      revert_available: false,
      staying_put: candidate !== null && semver.lt(candidate, currentVersion),
    };
  }
  const { latest_stable, latest_beta } = resolveMycoVersions(lineReleases);

  // Determine the target version for the active channel
  const latestStableStr = latest_stable ?? currentVersion;
  let latestVersion: string | null;
  if (channel === 'stable' || latest_beta === null) {
    latestVersion = latestStableStr;
  } else {
    // Beta channel: max(stable, beta) — no-downgrade rule
    latestVersion = semver.gt(latest_beta, latestStableStr) ? latest_beta : latestStableStr;
  }

  const updateAvailable =
    installedVersion !== null &&
    latestVersion !== null &&
    semver.valid(installedVersion) !== null &&
    semver.valid(latestVersion) !== null &&
    semver.gt(latestVersion, installedVersion);

  // Revert-to-stable: desired channel=stable, running binary is a prerelease,
  // and a stable target exists. Running version is the authoritative signal.
  const desiredStableRevert = channel === 'stable' && isPrerelease(currentVersion);
  const revertAvailable =
    desiredStableRevert &&
    latest_stable != null &&
    latestVersion !== null &&
    latestVersion !== currentVersion &&
    !updateAvailable;

  return {
    id: 'myco' as UpdatePackageId,
    display_name: 'Myco',
    package_name: NPM_PACKAGE_NAME,
    installed: installedVersion !== null,
    installed_version: installedVersion,
    latest_version: latestVersion,
    latest_stable: latestStableStr,
    latest_beta: latest_beta,
    update_available: updateAvailable,
    revert_available: revertAvailable,
  };
}
