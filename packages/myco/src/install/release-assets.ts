/**
 * GitHub release/channel/asset resolver.
 *
 * Pure module: no network calls. Operates on already-fetched GitHub API data
 * plus env values. The fetch layer lives in the Task 9 consumer.
 *
 * Exports:
 *   resolveTargetTriple  — maps process.platform/arch to a canonical triple
 *   assetName            — `myco-<triple>[.exe]`
 *   pickRelease          — highest-semver release for a channel (no-downgrade)
 *   assetDownloadUrl     — prefers browser_download_url; falls back to constructed
 *   parseSha256Sum       — parses a SHA256SUMS file body
 *   githubHeaders        — token-aware request headers (injectable env)
 */

import semver from 'semver';
import type { ReleaseChannel } from '@myco/constants/update';

// Derived from package.json `repository.url`
const MYCO_REPO = 'goondocks-co/myco';
const GITHUB_BASE = 'https://github.com';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TargetTriple =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'windows-x64';

/** Minimal shape of a GitHub release API object (what we read). */
export interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

// ---------------------------------------------------------------------------
// resolveTargetTriple
// ---------------------------------------------------------------------------

/**
 * Map `process.platform` + `process.arch` to a canonical asset triple.
 *
 * Throws a clear error for unsupported combinations (win32+arm64) or entirely
 * unknown platforms/architectures.
 */
export function resolveTargetTriple(
  platform: string = process.platform,
  arch: string = process.arch,
): TargetTriple {
  // Normalise arch aliases that appear in raw uname output
  const normArch =
    arch === 'aarch64' ? 'arm64' : arch === 'x86_64' || arch === 'amd64' ? 'x64' : arch;

  if (platform === 'darwin') {
    if (normArch === 'arm64') return 'darwin-arm64';
    if (normArch === 'x64') return 'darwin-x64';
    throw new Error(`Unsupported arch for darwin: ${arch}`);
  }

  if (platform === 'linux') {
    if (normArch === 'x64') return 'linux-x64';
    if (normArch === 'arm64') return 'linux-arm64';
    throw new Error(`Unsupported arch for linux: ${arch}`);
  }

  if (platform === 'win32') {
    if (normArch === 'arm64') {
      throw new Error('Windows arm64 is not supported — only windows-x64 is available');
    }
    if (normArch === 'x64') return 'windows-x64';
    throw new Error(`Unsupported arch for win32: ${arch}`);
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

// ---------------------------------------------------------------------------
// assetName
// ---------------------------------------------------------------------------

/**
 * Canonical asset filename for a given triple.
 * Only `windows-x64` gets the `.exe` suffix.
 */
export function assetName(triple: TargetTriple): string {
  return triple === 'windows-x64' ? `myco-${triple}.exe` : `myco-${triple}`;
}

// ---------------------------------------------------------------------------
// pickRelease (internal helpers)
// ---------------------------------------------------------------------------

const MYCO_TAG_RE = /^myco\/v(.+)$/;

/**
 * Determine whether a release is a prerelease.
 *
 * True when the GitHub `prerelease` flag is set OR when the semver version
 * has a prerelease component (e.g. `-beta.1`, `-alpha`, `-rc.2`).
 */
function isPrerelease(release: GitHubRelease, parsed: semver.SemVer): boolean {
  return release.prerelease || (parsed.prerelease?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// pickRelease
// ---------------------------------------------------------------------------

/**
 * Select the best release for the given channel from a GitHub releases array.
 *
 * Filtering:
 *   - Only tags matching `^myco/v` (excludes `myco-team/v*`, `myco-collective/v*`).
 *   - Tags whose suffix is not valid semver are skipped.
 *
 * Selection:
 *   - `stable`:  highest-semver release that is NOT a prerelease.
 *   - `beta`:    `max(highest-stable, highest-prerelease)` by semver.
 *                A stable `myco/v1.4.0` BEATS a prerelease `myco/v1.3.0-beta.1`
 *                (no-downgrade guarantee).
 *
 * Returns null if nothing matches.
 */
export function pickRelease(
  releases: GitHubRelease[],
  channel: ReleaseChannel,
): GitHubRelease | null {
  // Parse + classify all valid myco/v* releases
  const candidates: Array<{ release: GitHubRelease; parsed: semver.SemVer }> = [];

  for (const release of releases) {
    const match = MYCO_TAG_RE.exec(release.tag_name);
    if (!match) continue; // excludes myco-team/v*, myco-collective/v*, etc.

    const parsed = semver.parse(match[1]);
    if (!parsed) continue; // invalid semver suffix

    candidates.push({ release, parsed });
  }

  if (candidates.length === 0) return null;

  if (channel === 'stable') {
    const stableCandidates = candidates.filter(
      ({ release, parsed }) => !isPrerelease(release, parsed),
    );
    if (stableCandidates.length === 0) return null;
    stableCandidates.sort((a, b) => semver.rcompare(a.parsed, b.parsed));
    return stableCandidates[0].release;
  }

  // beta: max(stable, prerelease) — semver comparison handles the no-downgrade
  candidates.sort((a, b) => semver.rcompare(a.parsed, b.parsed));
  return candidates[0].release;
}

// ---------------------------------------------------------------------------
// assetDownloadUrl
// ---------------------------------------------------------------------------

/**
 * Resolve the download URL for a specific asset in a release.
 *
 * Prefers `browser_download_url` from the release's asset list (which the
 * GitHub API pre-encodes correctly even for tags containing slashes).
 * Falls back to constructing the canonical URL with the tag_name
 * percent-encoded.
 *
 * Returns null only if both strategies are exhausted (shouldn't happen in
 * practice for well-formed releases).
 */
export function assetDownloadUrl(release: GitHubRelease, triple: TargetTriple): string | null {
  const name = assetName(triple);

  const fromAssets = release.assets.find((a) => a.name === name)?.browser_download_url;
  if (fromAssets) return fromAssets;

  // Fallback: construct the URL manually. The tag contains a slash, so it must
  // be percent-encoded in the URL path.
  const encodedTag = encodeURIComponent(release.tag_name);
  return `${GITHUB_BASE}/${MYCO_REPO}/releases/download/${encodedTag}/${name}`;
}

// ---------------------------------------------------------------------------
// parseSha256Sum
// ---------------------------------------------------------------------------

/**
 * Parse a `SHA256SUMS` file and return the hex digest for the named asset.
 *
 * Each line has the format:
 *   `<hex>  <filename>`   (text mode, two spaces)
 *   `<hex> *<filename>`   (binary mode, space + asterisk)
 *
 * Matches when the filename field equals `asset` or `*asset`.
 * Returns null when the asset is not found in the file.
 */
export function parseSha256Sum(text: string, asset: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Split on first run of whitespace; field[0]=hash, field[1]=filename (may start with *)
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) continue;

    const hash = trimmed.slice(0, spaceIdx);
    const rest = trimmed.slice(spaceIdx).trimStart();

    // Strip optional binary-mode asterisk prefix
    const filename = rest.startsWith('*') ? rest.slice(1) : rest;

    if (filename === asset) return hash;
  }
  return null;
}

// ---------------------------------------------------------------------------
// githubHeaders
// ---------------------------------------------------------------------------

/**
 * Build GitHub API request headers.
 *
 * Honors `GITHUB_TOKEN` (checked first) then `GH_TOKEN` for Authorization.
 * Always includes `Accept: application/vnd.github+json` and `User-Agent`.
 *
 * The `env` parameter is injectable so callers can test without mutating the
 * real process environment. The token is NEVER logged.
 */
export function githubHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `myco-installer/${MYCO_REPO}`,
  };

  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}
