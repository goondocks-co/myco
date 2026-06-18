/**
 * Daemon-side myco release resolver (the impure fetch layer over the pure
 * `release-assets` module).
 *
 * Given a release channel, fetch the GitHub releases list, pick the channel's
 * release, and resolve the binary-update references for THIS machine's target
 * triple — the `{ assetUrl, sha256sumsUrl, assetName, targetVersion }` the
 * `applyBinaryUpdate` primitive consumes.
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

import {
  mycoReleasesApiUrl,
  githubHeaders,
  pickRelease,
  resolveAssetRefs,
  resolveTargetTriple,
  type AssetRefs,
  type GitHubRelease,
} from './release-assets.js';
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

async function fetchReleases(): Promise<GitHubRelease[]> {
  const res = await fetch(mycoReleasesApiUrl(), {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub releases responded with ${res.status}`);
  }
  return (await res.json()) as GitHubRelease[];
}

export const DEFAULT_RELEASE_RESOLVER_DEPS: MycoReleaseResolverDeps = {
  fetchReleases,
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
): Promise<AssetRefs | null> {
  const releases = await deps.fetchReleases();
  const release = pickRelease(releases, channel);
  if (!release) return null;
  const triple = deps.targetTriple();
  return resolveAssetRefs(release, triple);
}

/**
 * Resolve the binary-update refs for an EXACT target version (the
 * `myco update --target-version <ver>` / self-reconcile intent path).
 *
 * Matches the release whose tag is `myco/v<version>` exactly. Returns null when
 * no such release exists or it has no asset for this platform. The
 * `--target-version` flow carries only a version string (no channel / release
 * object), so we resolve it directly against the releases list.
 */
export async function resolveMycoBinaryUpdateRefsForVersion(
  version: string,
  deps: MycoReleaseResolverDeps = DEFAULT_RELEASE_RESOLVER_DEPS,
): Promise<AssetRefs | null> {
  const releases = await deps.fetchReleases();
  const release = releases.find((r) => r.tag_name === `myco/v${version}`);
  if (!release) return null;
  const triple = deps.targetTriple();
  return resolveAssetRefs(release, triple);
}
