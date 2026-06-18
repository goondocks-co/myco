/**
 * Operator-CLI version checker — resolves version check rows for
 * `myco-team` and `myco-collective` from the npm registry.
 *
 * Responsibility boundary: ONLY the operator/npm-registry packages.
 * No GitHub calls, no myco-core concern.
 *
 * Exports:
 *   checkOperatorCliVersions(...)  — fetch npm registry + derive PackageCheckResult[]
 */

import semver from 'semver';
import { NPM_REGISTRY_BASE_URL, UPDATE_PACKAGES } from '../constants/update.js';
import type { ReleaseChannel, UpdatePackageId } from '../constants/update.js';
import type { PackageCheckResult } from '../upgrade/checker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NpmDistTags {
  latest: string;
  beta?: string;
  [tag: string]: string | undefined;
}

interface NpmRegistryResponse {
  'dist-tags': NpmDistTags;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function packageRegistryUrl(packageName: string): string {
  return `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}`;
}

function resolveTargetFromDistTags(
  distTags: NpmDistTags,
  channel: ReleaseChannel,
): string {
  const stable = distTags.latest;
  const beta = distTags.beta ?? null;

  if (channel === 'stable' || beta === null) return stable;

  return semver.gt(beta, stable) ? beta : stable;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Fetch npm registry for each operator-CLI package (myco-team, myco-collective)
 * and return a `PackageCheckResult[]` — one row per package.
 *
 * - `channel`           — effective release channel (stable | beta)
 * - `installedVersions` — map of package id → installed version (null if absent)
 * - `fetchFn`           — injectable fetch (defaults to global fetch; tests mock it)
 *
 * Each package is fetched concurrently. On failure for a given package the
 * promise rejects with an error message that callers (shim / Task 7) can
 * collect via Promise.allSettled.
 *
 * Returns only the OPERATOR packages (excludes `myco` — that is
 * `resolveMycoPackageCheck`'s responsibility).
 */
export async function checkOperatorCliVersions(
  channel: ReleaseChannel,
  installedVersions: Partial<Record<UpdatePackageId, string | null>>,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<PackageCheckResult[]> {
  const operatorPackages = UPDATE_PACKAGES.filter((pkg) => pkg.id !== 'myco');

  const settled = await Promise.allSettled(
    operatorPackages.map(async (pkg) => {
      const response = await fetchFn(packageRegistryUrl(pkg.packageName), {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`${pkg.packageName}: registry responded with ${response.status}`);
      }

      const data = (await response.json()) as NpmRegistryResponse;
      const distTags = data['dist-tags'];
      const latestVersion = resolveTargetFromDistTags(distTags, channel);
      const installedVersion = installedVersions[pkg.id] ?? null;

      const updateAvailable =
        installedVersion !== null &&
        semver.valid(installedVersion) !== null &&
        semver.valid(latestVersion) !== null &&
        semver.gt(latestVersion, installedVersion);

      return {
        id: pkg.id as UpdatePackageId,
        display_name: pkg.displayName,
        package_name: pkg.packageName,
        installed: installedVersion !== null,
        installed_version: installedVersion,
        latest_version: latestVersion,
        latest_stable: distTags.latest,
        latest_beta: distTags.beta ?? null,
        update_available: updateAvailable,
        revert_available: false, // operator CLIs have no revert concept
      } satisfies PackageCheckResult;
    }),
  );

  const results: PackageCheckResult[] = [];
  const errors: string[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      const message = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
      errors.push(message);
    }
  }

  if (errors.length > 0 && results.length === 0) {
    // All packages failed — throw so the shim can handle gracefully
    throw new Error(errors.join('; '));
  }

  // Partial failures: return what we have (shim fills from cache for missing)
  return results;
}
