/**
 * Daemon-side myco release resolver (the impure fetch layer over the pure
 * `release-assets` module).
 *
 * Given a release channel, fetch the GitHub releases list, pick the channel's
 * release, and resolve the binary-update references for THIS machine's target
 * triple — the `{ assetUrl, sha256sumsUrl, assetName, targetVersion }` the
 * `stageBinary` primitive consumes.
 *
 * The daemon resolves these BEFORE it spawns the detached `__apply-update`
 * orchestrator, because the orchestrator runs after the daemon has exited and
 * must not re-discover the release itself. Keeping the resolution in the daemon
 * also means a resolution failure (offline, rate-limited, no asset for this
 * platform) surfaces as a clean update-time error instead of stranding a
 * half-spawned orchestrator.
 *
 * `release-assets` stays pure; the single `fetch` lives here.
 */

import { isV2Version } from '../../scripts/release-policy.mjs';

import {
  mycoReleasesApiUrl,
  githubHeaders,
  pickRelease,
  resolveAssetRefs,
  resolveTargetTriple,
  assetName,
  type AssetRefs,
  type GitHubRelease,
} from './release-assets.js';
import { getPluginVersion } from '../version.js';
import type { FetchLike } from '../utils/instrumented-fetch.js';
import type { ReleaseChannel } from '../constants/update.js';

/** Timeout for the GitHub releases fetch. Mirrors the update-checker probe. */
const RELEASES_FETCH_TIMEOUT_MS = 10_000;

/** Injectable dependencies (real implementations by default; tests override). */
export interface MycoReleaseResolverDeps {
  /** Fetch the GitHub releases list (already token-aware via githubHeaders). */
  fetchReleases: () => Promise<GitHubRelease[]>;
  /** Resolve this machine's target triple (process.platform/arch by default). */
  targetTriple: () => ReturnType<typeof resolveTargetTriple>;
}

/** Bound release discovery; exhaustion fails instead of choosing from a partial list. */
export const MAX_RELEASE_PAGES = 100;

export async function fetchMycoReleases(fetchFn: FetchLike = globalThis.fetch): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const url = mycoReleasesApiUrl() + (page === 1 ? '' : `&page=${page}`);
    const res = await fetchFn(url, { headers: githubHeaders(), signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub releases responded with ${res.status}`);
    const batch = await res.json() as GitHubRelease[];
    if (!Array.isArray(batch)) throw new Error('GitHub releases response must be an array');
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error(`GitHub release discovery exceeded ${MAX_RELEASE_PAGES} pages`);
}

export const DEFAULT_RELEASE_RESOLVER_DEPS: MycoReleaseResolverDeps = {
  fetchReleases: fetchMycoReleases,
  targetTriple: () => resolveTargetTriple(),
};

/**
 * Resolve the binary-update refs for the given channel + this machine.
 *
 * Returns null when no release matches the channel (e.g. a stable channel
 * against a beta-only repo) or the resolved release has no asset for this
 * platform. Throws only on a hard fetch/triple failure the caller should
 * surface (offline, rate-limited, unsupported platform).
 */
export async function resolveMycoBinaryUpdateRefs(
  channel: ReleaseChannel,
  deps: MycoReleaseResolverDeps = DEFAULT_RELEASE_RESOLVER_DEPS,
  currentVersion: string = getPluginVersion(),
): Promise<AssetRefs | null> {
  const releases = await deps.fetchReleases();
  const triple = deps.targetTriple();
  const isV2 = isV2Version(currentVersion);
  const release = pickRelease(releases, channel, {
    asset: isV2 ? assetName(triple) : undefined, currentVersion: isV2 ? currentVersion : undefined,
    minimumMajor: isV2 ? 2 : 1, maximumMajor: isV2 ? undefined : 1,
  });
  if (!release) {
    const candidate = pickRelease(releases, channel, { asset: assetName(triple), minimumMajor: isV2 ? 2 : 1, maximumMajor: isV2 ? undefined : 1 });
    if (candidate && isV2) console.warn(`Newest eligible ${channel} release ${candidate.tag_name.slice(6)} is older than installed ${currentVersion}; staying put.`);
    return null;
  }
  return resolveAssetRefs(release, triple);
}

