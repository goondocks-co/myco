/**
 * Tests for the daemon-side myco release resolver (the impure fetch layer over
 * the pure `release-assets` module).
 *
 * All fetching is injected so the tests touch no network. The resolver:
 *   - by channel: fetch → pickRelease → resolveAssetRefs for this triple
 *   - by exact version: fetch → match `myco/v<version>` → resolveAssetRefs
 *   - returns null when no release matches / no asset for this platform
 */

import { describe, it, expect } from 'bun:test';
import {
  resolveMycoBinaryUpdateRefs,
  resolveMycoBinaryUpdateRefsForVersion,
  type MycoReleaseResolverDeps,
} from '@myco/daemon/myco-release-resolver.js';
import type { GitHubRelease } from '@myco/install/release-assets.js';

function release(tag: string, prerelease: boolean): GitHubRelease {
  return {
    tag_name: tag,
    prerelease,
    assets: [
      { name: 'myco-darwin-arm64', browser_download_url: `https://dl.test/${tag}/myco-darwin-arm64` },
      { name: 'SHA256SUMS', browser_download_url: `https://dl.test/${tag}/SHA256SUMS` },
    ],
  };
}

function deps(releases: GitHubRelease[]): MycoReleaseResolverDeps {
  return {
    fetchReleases: async () => releases,
    targetTriple: () => 'darwin-arm64',
  };
}

describe('resolveMycoBinaryUpdateRefs (by channel)', () => {
  it('stable: resolves the highest non-prerelease release', async () => {
    const refs = await resolveMycoBinaryUpdateRefs(
      'stable',
      deps([release('myco/v1.4.0', false), release('myco/v1.5.0-beta.1', true)]),
    );
    expect(refs).toEqual({
      assetUrl: 'https://dl.test/myco/v1.4.0/myco-darwin-arm64',
      sha256sumsUrl: 'https://dl.test/myco/v1.4.0/SHA256SUMS',
      assetName: 'myco-darwin-arm64',
      targetVersion: '1.4.0',
    });
  });

  it('beta: resolves the highest prerelease when it beats stable', async () => {
    const refs = await resolveMycoBinaryUpdateRefs(
      'beta',
      deps([release('myco/v1.4.0', false), release('myco/v1.5.0-beta.1', true)]),
    );
    expect(refs?.targetVersion).toBe('1.5.0-beta.1');
    expect(refs?.sha256sumsUrl).toContain('SHA256SUMS');
  });

  it('returns null when no release matches the channel', async () => {
    const refs = await resolveMycoBinaryUpdateRefs('stable', deps([release('myco/v1.0.0-beta.1', true)]));
    expect(refs).toBeNull();
  });

  it('ignores sibling-package tags', async () => {
    const refs = await resolveMycoBinaryUpdateRefs(
      'stable',
      deps([release('myco-team/v9.9.9', false), release('myco/v1.2.0', false)]),
    );
    expect(refs?.targetVersion).toBe('1.2.0');
  });
});

describe('resolveMycoBinaryUpdateRefsForVersion (exact version)', () => {
  it('matches the release tagged myco/v<version>', async () => {
    const refs = await resolveMycoBinaryUpdateRefsForVersion(
      '1.3.0',
      deps([release('myco/v1.2.0', false), release('myco/v1.3.0', false)]),
    );
    expect(refs?.targetVersion).toBe('1.3.0');
    expect(refs?.assetUrl).toBe('https://dl.test/myco/v1.3.0/myco-darwin-arm64');
  });

  it('returns null when no release matches the exact version', async () => {
    const refs = await resolveMycoBinaryUpdateRefsForVersion('9.9.9', deps([release('myco/v1.3.0', false)]));
    expect(refs).toBeNull();
  });
});
