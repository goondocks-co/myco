import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { RELEASE_TARGETS } from '../../packages/myco/scripts/release-targets.mjs';
import {
  resolveTargetTriple,
  resolveAssetRefs,
  assetName,
  pickRelease,
  assetDownloadUrl,
  parseSha256Sum,
  githubHeaders,
  mycoReleasesApiUrl,
  resolveMycoVersions,
  type GitHubRelease,
} from '@myco/upgrade/release-assets';

describe('resolveTargetTriple and assetName', () => {
  it('map each platform and architecture a release builds to the asset it publishes, the x64 build never on ARM64', () => {
    const cases = [['darwin', 'arm64', 'myco-darwin-arm64'], ['darwin', 'x64', 'myco-darwin-x64'], ['linux', 'x86_64', 'myco-linux-x64'],
      ['linux', 'aarch64', 'myco-linux-arm64'], ['win32', 'x64', 'myco-windows-x64.exe'], ['win32', 'arm64', 'myco-windows-arm64.exe']];
    expect(cases.map(([platform, arch]) => assetName(resolveTargetTriple(platform, arch)))).toEqual(cases.map((one) => one[2]));
  });

  it('refuses a platform or architecture no release builds', () => {
    expect(() => resolveTargetTriple('freebsd', 'x64')).toThrow(/unsupported platform/i);
    expect(() => resolveTargetTriple('linux', 'ia32')).toThrow(/unsupported arch/i);
  });

  it('names, across every release target, exactly the assets a release publishes', () => {
    const listed = spawnSync('bash', ['-c', 'source scripts/release-assets.sh && printf "%s\\n" "${MYCO_RELEASE_BINARIES[@]}"'], { encoding: 'utf8' });
    expect(RELEASE_TARGETS.map((target) => assetName(target.name)).sort()).toEqual(listed.stdout.trim().split('\n').sort());
  });

  it('resolves a Windows ARM64 machine\'s update to the ARM64 asset', () => {
    const asset = (name: string) => ({ name, browser_download_url: `https://example.invalid/${name}` });
    const release = { tag_name: 'myco/v2.0.0', prerelease: false, assets: ['myco-windows-x64.exe', 'myco-windows-arm64.exe', 'SHA256SUMS'].map(asset) };
    expect(resolveAssetRefs(release, resolveTargetTriple('win32', 'arm64'))).toMatchObject({ assetUrl: 'https://example.invalid/myco-windows-arm64.exe', assetName: 'myco-windows-arm64.exe' });
  });
});

// ---------------------------------------------------------------------------
// Fixture releases for pickRelease tests
// ---------------------------------------------------------------------------
function makeRelease(
  tagName: string,
  prerelease: boolean,
  version?: string,
): GitHubRelease {
  const v = version ?? tagName.replace(/^[^/]+\/v/, '');
  return {
    tag_name: tagName,
    prerelease,
    assets: [
      {
        name: `myco-darwin-arm64`,
        browser_download_url: `https://github.com/goondocks-co/myco/releases/download/${encodeURIComponent(tagName)}/myco-darwin-arm64`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// pickRelease
// ---------------------------------------------------------------------------
describe('pickRelease', () => {
  const releases: GitHubRelease[] = [
    // Sibling package tag — MUST be excluded
    makeRelease('myco-team/v9.9.9', false),
    makeRelease('myco-collective/v8.0.0', false),
    // Valid myco releases
    makeRelease('myco/v1.0.0', false),
    makeRelease('myco/v1.2.0', false),
    makeRelease('myco/v1.3.0-beta.1', true),
    makeRelease('myco/v1.4.0', false),
    makeRelease('myco/v1.5.0-beta.2', true),
    // A release with bad semver in the suffix — must be skipped
    makeRelease('myco/vnot-semver', false),
  ];

  it('stable channel → highest non-prerelease (v1.4.0, not team/collective)', () => {
    const result = pickRelease(releases, 'stable');
    expect(result?.tag_name).toBe('myco/v1.4.0');
  });

  it('stable channel → excludes sibling package tags entirely', () => {
    const result = pickRelease(releases, 'stable');
    expect(result?.tag_name).not.toMatch(/^myco-team\//);
    expect(result?.tag_name).not.toMatch(/^myco-collective\//);
  });

  it('beta channel → highest overall by semver (v1.5.0-beta.2 > v1.4.0)', () => {
    const result = pickRelease(releases, 'beta');
    expect(result?.tag_name).toBe('myco/v1.5.0-beta.2');
  });

  it('NO-DOWNGRADE: beta channel picks stable v1.4.0 over prerelease v1.3.0-beta.1', () => {
    const noDowngradeFixture: GitHubRelease[] = [
      makeRelease('myco/v1.4.0', false),
      makeRelease('myco/v1.3.0-beta.1', true),
    ];
    const result = pickRelease(noDowngradeFixture, 'beta');
    expect(result?.tag_name).toBe('myco/v1.4.0');
  });

  it('beta channel picks genuine higher prerelease over lower stable', () => {
    const fixture: GitHubRelease[] = [
      makeRelease('myco/v1.4.0', false),
      makeRelease('myco/v1.5.0-beta.2', true),
    ];
    const result = pickRelease(fixture, 'beta');
    expect(result?.tag_name).toBe('myco/v1.5.0-beta.2');
  });

  it('prerelease detection: prerelease flag OR semver prerelease component', () => {
    // Tag is labeled prerelease:false but has -alpha in version (semver component)
    const fixture: GitHubRelease[] = [
      makeRelease('myco/v2.0.0-alpha.1', false), // flag says false, semver says prerelease
      makeRelease('myco/v1.9.0', false),
    ];
    // stable channel should NOT pick the alpha even though flag is false
    const stableResult = pickRelease(fixture, 'stable');
    expect(stableResult?.tag_name).toBe('myco/v1.9.0');
    // Beta admits beta and stable tags.
    const betaResult = pickRelease(fixture, 'beta');
    expect(betaResult?.tag_name).toBe('myco/v1.9.0');
    expect(pickRelease(fixture, 'alpha')?.tag_name).toBe('myco/v2.0.0-alpha.1');
  });

  it('prerelease detection: rc suffix counts as prerelease', () => {
    const fixture: GitHubRelease[] = [
      makeRelease('myco/v2.0.0-rc.1', true),
      makeRelease('myco/v1.9.0', false),
    ];
    const stableResult = pickRelease(fixture, 'stable');
    expect(stableResult?.tag_name).toBe('myco/v1.9.0');
  });

  it('returns null when no matching releases exist', () => {
    expect(pickRelease([], 'stable')).toBeNull();
    expect(pickRelease([makeRelease('myco-team/v1.0.0', false)], 'stable')).toBeNull();
  });

  it('skips tags with invalid semver after stripping myco/v prefix', () => {
    const result = pickRelease([makeRelease('myco/vnot-semver', false)], 'stable');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assetDownloadUrl
// ---------------------------------------------------------------------------
describe('assetDownloadUrl', () => {
  it('prefers browser_download_url from release assets', () => {
    const release: GitHubRelease = {
      tag_name: 'myco/v1.0.0',
      prerelease: false,
      assets: [
        {
          name: 'myco-darwin-arm64',
          browser_download_url:
            'https://github.com/goondocks-co/myco/releases/download/myco%2Fv1.0.0/myco-darwin-arm64',
        },
      ],
    };
    const url = assetDownloadUrl(release, 'darwin-arm64');
    expect(url).toBe(
      'https://github.com/goondocks-co/myco/releases/download/myco%2Fv1.0.0/myco-darwin-arm64',
    );
  });

  it('falls back to constructed URL when asset not in array', () => {
    const release: GitHubRelease = {
      tag_name: 'myco/v1.0.0',
      prerelease: false,
      assets: [],
    };
    const url = assetDownloadUrl(release, 'linux-x64');
    expect(url).toBe(
      'https://github.com/goondocks-co/myco/releases/download/myco%2Fv1.0.0/myco-linux-x64',
    );
  });

  it('falls back URL encodes the slash in tag_name', () => {
    const release: GitHubRelease = {
      tag_name: 'myco/v2.0.0-beta.1',
      prerelease: true,
      assets: [],
    };
    const url = assetDownloadUrl(release, 'windows-x64');
    expect(url).toContain('myco%2Fv2.0.0-beta.1');
    expect(url).toContain('myco-windows-x64.exe');
  });
});

// ---------------------------------------------------------------------------
// parseSha256Sum
// ---------------------------------------------------------------------------
describe('parseSha256Sum', () => {
  it('returns the digest listed for exactly the named asset, in text or binary mode, and null for one not listed', () => {
    const digest = (hex: string) => hex.repeat(64);
    const text = [`${digest('a')}  myco-darwin-arm64`, `${digest('b')} *myco-darwin-x64`, `${digest('c')}  other-file`].join('\n');
    expect(['myco-darwin-arm64', 'myco-darwin-x64', 'other-file', 'myco-windows-x64.exe'].map((asset) => parseSha256Sum(text, asset)))
      .toEqual([digest('a'), digest('b'), digest('c'), null]);
    expect(parseSha256Sum('', 'myco-darwin-arm64')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// githubHeaders
// ---------------------------------------------------------------------------
describe('githubHeaders', () => {
  it('includes Authorization: Bearer when GITHUB_TOKEN is set', () => {
    const headers = githubHeaders({ GITHUB_TOKEN: 'token-abc' });
    expect(headers['Authorization']).toBe('Bearer token-abc');
    expect(headers['Accept']).toBe('application/vnd.github+json');
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is absent', () => {
    const headers = githubHeaders({ GH_TOKEN: 'gh-token-xyz' });
    expect(headers['Authorization']).toBe('Bearer gh-token-xyz');
  });

  it('GITHUB_TOKEN takes precedence over GH_TOKEN', () => {
    const headers = githubHeaders({ GITHUB_TOKEN: 'primary', GH_TOKEN: 'secondary' });
    expect(headers['Authorization']).toBe('Bearer primary');
  });

  it('no Authorization header when no token env vars set', () => {
    const headers = githubHeaders({});
    expect(Object.prototype.hasOwnProperty.call(headers, 'Authorization')).toBe(false);
    expect(headers['Accept']).toBe('application/vnd.github+json');
  });

  it('includes User-Agent header', () => {
    const headers = githubHeaders({});
    expect(headers['User-Agent']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// mycoReleasesApiUrl
// ---------------------------------------------------------------------------
describe('mycoReleasesApiUrl', () => {
  it('returns the GitHub releases API URL for the myco repo', () => {
    const url = mycoReleasesApiUrl();
    expect(url).toBe('https://api.github.com/repos/goondocks-co/myco/releases?per_page=100');
  });
});

// ---------------------------------------------------------------------------
// resolveMycoVersions
// ---------------------------------------------------------------------------
describe('resolveMycoVersions', () => {
  function makeReleaseFull(
    tagName: string,
    prerelease: boolean,
  ): GitHubRelease {
    return { tag_name: tagName, prerelease, assets: [] };
  }

  it('stable+beta fixture: latest_stable is highest non-prerelease, latest_beta is highest prerelease', () => {
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco/v1.4.0', false),        // stable
      makeReleaseFull('myco/v1.3.0-beta.1', true),  // prerelease
      makeReleaseFull('myco/v1.5.0-beta.2', true),  // prerelease (higher)
      makeReleaseFull('myco-team/v9.9.9', false),   // sibling — must be excluded
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBe('1.4.0');
    expect(result.latest_beta).toBe('1.5.0-beta.2');
  });

  it('sibling package tags are excluded from both stable and beta', () => {
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco-team/v9.9.9', false),
      makeReleaseFull('myco-collective/v8.0.0', true),
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBeNull();
    expect(result.latest_beta).toBeNull();
  });

  it('beta-only fixture: latest_stable is null', () => {
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco/v1.0.0-beta.1', true),
      makeReleaseFull('myco/v1.1.0-beta.2', true),
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBeNull();
    expect(result.latest_beta).toBe('1.1.0-beta.2');
  });

  it('stable-only fixture: latest_beta is null', () => {
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco/v1.0.0', false),
      makeReleaseFull('myco/v1.2.0', false),
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBe('1.2.0');
    expect(result.latest_beta).toBeNull();
  });

  it('empty releases: both null', () => {
    expect(resolveMycoVersions([])).toEqual({ latest_stable: null, latest_beta: null });
  });

  it('semver component detection: flag=false but -alpha suffix → treated as prerelease', () => {
    // The prerelease flag is false but the semver prerelease component is present
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco/v2.0.0-alpha.1', false), // flag=false but semver says prerelease
      makeReleaseFull('myco/v1.9.0', false),          // genuine stable
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBe('1.9.0');
    expect(result.latest_beta).toBe('2.0.0-alpha.1');
  });

  it('picks the highest stable across multiple stable releases', () => {
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco/v1.0.0', false),
      makeReleaseFull('myco/v1.3.0', false),
      makeReleaseFull('myco/v1.2.5', false),
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBe('1.3.0');
  });

  it('skips releases with invalid semver in the tag suffix', () => {
    const releases: GitHubRelease[] = [
      makeReleaseFull('myco/vnot-semver', false),
      makeReleaseFull('myco/v1.0.0', false),
    ];

    const result = resolveMycoVersions(releases);
    expect(result.latest_stable).toBe('1.0.0');
  });
});
