import { describe, it, expect } from 'bun:test';
import {
  resolveTargetTriple,
  assetName,
  pickRelease,
  assetDownloadUrl,
  parseSha256Sum,
  githubHeaders,
  type GitHubRelease,
} from '@myco/install/release-assets';

// ---------------------------------------------------------------------------
// resolveTargetTriple
// ---------------------------------------------------------------------------
describe('resolveTargetTriple', () => {
  it('maps darwin + arm64 → darwin-arm64', () => {
    expect(resolveTargetTriple('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('maps darwin + x64 → darwin-x64', () => {
    expect(resolveTargetTriple('darwin', 'x64')).toBe('darwin-x64');
  });

  it('maps linux + x64 → linux-x64', () => {
    expect(resolveTargetTriple('linux', 'x64')).toBe('linux-x64');
  });

  it('maps linux + arm64 → linux-arm64', () => {
    expect(resolveTargetTriple('linux', 'arm64')).toBe('linux-arm64');
  });

  it('maps win32 + x64 → windows-x64', () => {
    expect(resolveTargetTriple('win32', 'x64')).toBe('windows-x64');
  });

  it('throws on win32 + arm64 (unsupported)', () => {
    expect(() => resolveTargetTriple('win32', 'arm64')).toThrow(
      /windows.*arm64.*not supported/i,
    );
  });

  it('throws on unknown platform', () => {
    expect(() => resolveTargetTriple('freebsd', 'x64')).toThrow(/unsupported platform/i);
  });

  it('throws on unknown arch for a known platform', () => {
    expect(() => resolveTargetTriple('linux', 'ia32')).toThrow(/unsupported arch/i);
  });
});

// ---------------------------------------------------------------------------
// assetName
// ---------------------------------------------------------------------------
describe('assetName', () => {
  it('darwin-arm64 → myco-darwin-arm64 (no .exe)', () => {
    expect(assetName('darwin-arm64')).toBe('myco-darwin-arm64');
  });

  it('darwin-x64 → myco-darwin-x64', () => {
    expect(assetName('darwin-x64')).toBe('myco-darwin-x64');
  });

  it('linux-x64 → myco-linux-x64', () => {
    expect(assetName('linux-x64')).toBe('myco-linux-x64');
  });

  it('linux-arm64 → myco-linux-arm64', () => {
    expect(assetName('linux-arm64')).toBe('myco-linux-arm64');
  });

  it('windows-x64 → myco-windows-x64.exe (.exe suffix only for windows)', () => {
    expect(assetName('windows-x64')).toBe('myco-windows-x64.exe');
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
    // beta channel should include it and pick the higher one
    const betaResult = pickRelease(fixture, 'beta');
    expect(betaResult?.tag_name).toBe('myco/v2.0.0-alpha.1');
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
  const sha256text = [
    'aabbccdd0011223344556677889900aabbccdd0011223344556677889900aabb  myco-darwin-arm64',
    '1122334455667788990011223344556677889900aabbccddeeff001122334455  myco-linux-x64',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef *myco-darwin-x64',
    '0000000000000000000000000000000000000000000000000000000000000000  other-file',
  ].join('\n');

  it('returns hex hash for exact asset name match (space-separated)', () => {
    expect(parseSha256Sum(sha256text, 'myco-darwin-arm64')).toBe(
      'aabbccdd0011223344556677889900aabbccdd0011223344556677889900aabb',
    );
  });

  it('returns hex hash for linux-x64', () => {
    expect(parseSha256Sum(sha256text, 'myco-linux-x64')).toBe(
      '1122334455667788990011223344556677889900aabbccddeeff001122334455',
    );
  });

  it('handles *asset binary-mode prefix', () => {
    expect(parseSha256Sum(sha256text, 'myco-darwin-x64')).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
  });

  it('ignores lines for other files', () => {
    expect(parseSha256Sum(sha256text, 'other-file')).toBe(
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('returns null when asset is not found', () => {
    expect(parseSha256Sum(sha256text, 'myco-windows-x64.exe')).toBeNull();
  });

  it('returns null on empty text', () => {
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
