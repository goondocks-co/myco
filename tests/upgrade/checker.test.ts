/**
 * Tests for upgrade/checker.ts — resolveMycoPackageCheck
 *
 * Covers:
 * - myco row resolves latest_stable + latest_beta from GitHub Releases
 * - update_available is true when GitHub has a strictly higher version
 * - revert_available for prerelease-running + desired-stable case
 * - no-downgrade rule on beta channel (stable beats lower prerelease)
 * - sibling package tags (myco-team/*, myco-collective/*) are excluded
 * - !response.ok throws so callers can collect the error
 */

import { describe, it, expect } from 'bun:test';
import { resolveMycoPackageCheck } from '@myco/upgrade/checker.js';
import { mycoReleasesApiUrl } from '@myco/upgrade/release-assets.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeRelease {
  tag_name: string;
  prerelease: boolean;
  assets: [];
}

function makeRelease(tagName: string, prerelease: boolean): FakeRelease {
  return { tag_name: tagName, prerelease, assets: [] };
}

const GITHUB_URL = mycoReleasesApiUrl();

function makeFetchFn(releases: FakeRelease[], status = 200): typeof fetch {
  return async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    if (urlStr === GITHUB_URL) {
      if (status !== 200) {
        return new Response(JSON.stringify([]), { status });
      }
      return new Response(JSON.stringify(releases), { status: 200 });
    }
    throw new Error(`Unexpected URL in checker test: ${urlStr}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveMycoPackageCheck() — stable channel', () => {
  it('returns latest_stable from GitHub releases', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0',
      'stable',
      '1.0.0',
      makeFetchFn([
        makeRelease('myco/v1.5.0', false),
        makeRelease('myco/v1.4.0', false),
      ]),
    );

    expect(result.latest_stable).toBe('1.5.0');
    expect(result.latest_beta).toBeNull();
    expect(result.update_available).toBe(true);
    expect(result.installed_version).toBe('1.0.0');
  });

  it('update_available=false when running version matches stable', async () => {
    const result = await resolveMycoPackageCheck(
      '1.5.0',
      'stable',
      '1.5.0',
      makeFetchFn([makeRelease('myco/v1.5.0', false)]),
    );

    expect(result.update_available).toBe(false);
    expect(result.revert_available).toBe(false);
  });

  it('update_available=false when running version is newer than stable', async () => {
    const result = await resolveMycoPackageCheck(
      '2.0.0',
      'stable',
      '2.0.0',
      makeFetchFn([makeRelease('myco/v1.5.0', false)]),
    );

    expect(result.update_available).toBe(false);
  });

  it('ignores sibling package tags (myco-team, myco-collective)', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0',
      'stable',
      '1.0.0',
      makeFetchFn([
        makeRelease('myco/v1.5.0', false),
        makeRelease('myco-team/v9.9.9', false),        // sibling — must be excluded
        makeRelease('myco-collective/v8.0.0', false),  // sibling — must be excluded
      ]),
    );

    expect(result.latest_stable).toBe('1.5.0');
    expect(result.latest_version).toBe('1.5.0');
  });

  it('latest_stable falls back to currentVersion when no stable releases exist', async () => {
    const result = await resolveMycoPackageCheck(
      '0.9.0',
      'stable',
      '0.9.0',
      makeFetchFn([makeRelease('myco/v1.0.0-beta.1', true)]),
    );

    expect(result.latest_stable).toBe('0.9.0');
    expect(result.latest_beta).toBe('1.0.0-beta.1');
    expect(result.update_available).toBe(false); // stable target = 0.9.0 = current
  });

  it('returns correct package metadata', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0',
      'stable',
      '1.0.0',
      makeFetchFn([makeRelease('myco/v1.1.0', false)]),
    );

    expect(result.id).toBe('myco');
    expect(result.display_name).toBe('Myco');
    expect(result.package_name).toBe('@goondocks/myco');
    expect(result.installed).toBe(true);
  });

  it('installed=false when installedVersion is null', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0',
      'stable',
      null, // not installed globally
      makeFetchFn([makeRelease('myco/v1.1.0', false)]),
    );

    expect(result.installed).toBe(false);
    expect(result.installed_version).toBeNull();
    expect(result.update_available).toBe(false); // can't update what isn't installed
  });
});

describe('resolveMycoPackageCheck() — revert_available logic', () => {
  it('revert_available=true for prerelease-running + desired-stable + stable target exists', async () => {
    // KEY CASE: running 1.1.0-beta.1, desired channel=stable, stable=1.0.0 exists.
    // This is the "beta user who wants to step back to stable" case.
    const result = await resolveMycoPackageCheck(
      '1.1.0-beta.1', // running prerelease
      'stable',       // desired channel
      '1.1.0-beta.1',
      makeFetchFn([
        makeRelease('myco/v1.0.0', false), // stable target
        makeRelease('myco/v1.1.0-beta.1', true),
      ]),
    );

    // stable channel target is 1.0.0 (not newer than running 1.1.0-beta.1)
    expect(result.update_available).toBe(false);
    expect(result.revert_available).toBe(true);
    expect(result.latest_version).toBe('1.0.0');
    expect(result.latest_stable).toBe('1.0.0');
  });

  it('revert_available=false when running a stable version', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0', // stable running
      'stable',
      '1.0.0',
      makeFetchFn([
        makeRelease('myco/v1.0.0', false),
        makeRelease('myco/v1.1.0-beta.1', true),
      ]),
    );

    expect(result.update_available).toBe(false);
    expect(result.revert_available).toBe(false);
  });

  it('revert_available=false when update_available (newer stable exists)', async () => {
    // Running a prerelease but a NEWER stable also exists → that's an update, not a revert.
    const result = await resolveMycoPackageCheck(
      '1.0.0-beta.1', // running prerelease
      'stable',
      '1.0.0-beta.1',
      makeFetchFn([makeRelease('myco/v1.1.0', false)]), // stable 1.1.0 > beta
    );

    expect(result.update_available).toBe(true);
    expect(result.revert_available).toBe(false);
  });

  it('revert_available=false on beta channel even when running a prerelease', async () => {
    // Beta channel: no "revert to stable" concept — user opted into beta.
    const result = await resolveMycoPackageCheck(
      '1.1.0-beta.1',
      'beta',
      '1.1.0-beta.1',
      makeFetchFn([
        makeRelease('myco/v1.0.0', false),
        makeRelease('myco/v1.1.0-beta.1', true),
      ]),
    );

    expect(result.revert_available).toBe(false);
  });
});

describe('resolveMycoPackageCheck() — beta channel', () => {
  it('picks the higher prerelease over stable (genuine higher beta)', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0',
      'beta',
      '1.0.0',
      makeFetchFn([
        makeRelease('myco/v1.4.0', false),
        makeRelease('myco/v1.5.0-beta.2', true), // higher than stable
      ]),
    );

    expect(result.latest_version).toBe('1.5.0-beta.2');
    expect(result.latest_beta).toBe('1.5.0-beta.2');
    expect(result.update_available).toBe(true);
  });

  it('no-downgrade: picks stable v1.4.0 over lower prerelease v1.3.0-beta.1', async () => {
    const result = await resolveMycoPackageCheck(
      '1.0.0',
      'beta',
      '1.0.0',
      makeFetchFn([
        makeRelease('myco/v1.4.0', false),
        makeRelease('myco/v1.3.0-beta.1', true), // lower than stable
      ]),
    );

    expect(result.latest_version).toBe('1.4.0');
    expect(result.latest_beta).toBe('1.3.0-beta.1');
    expect(result.update_available).toBe(true);
  });
});

describe('resolveMycoPackageCheck() — error handling', () => {
  it('throws on !response.ok so callers can collect via Promise.allSettled', async () => {
    await expect(
      resolveMycoPackageCheck(
        '1.0.0',
        'stable',
        '1.0.0',
        makeFetchFn([], 429),
      ),
    ).rejects.toThrow('429');
  });

  it('throws on network error', async () => {
    const failingFetch = async () => {
      throw new Error('network error');
    };

    await expect(
      resolveMycoPackageCheck('1.0.0', 'stable', '1.0.0', failingFetch as typeof fetch),
    ).rejects.toThrow('network error');
  });
});
