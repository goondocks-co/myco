/**
 * Tests for the GitHub-Releases path in checkForUpdate.
 *
 * Verifies that:
 *   - the `myco` package resolves latest_stable / latest_beta from GitHub Releases
 *   - sibling package tags (myco-team/*, myco-collective/*) are excluded from myco's row
 *   - myco-team and myco-collective still resolve from the npm registry
 *   - CheckResult / PackageCheckResult shape is unchanged
 *   - update_available is correct (false when running==target, true when GitHub has higher)
 *   - no-downgrade is honoured on the beta channel (stable beats lower beta)
 *   - !response.ok from GitHub flows into the existing Promise.allSettled error path
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use the mocked modules
// ---------------------------------------------------------------------------

const fsMocks = {
  existsSync: mock(() => false),
  readFileSync: mock(() => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
  statSync: mock(() => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
  realpathSync: mock((p: unknown) => String(p)),
  writeFileSync: mock(() => undefined),
  mkdirSync: mock(() => undefined),
  unlinkSync: mock(() => undefined),
  renameSync: mock(() => undefined),
  openSync: mock(() => 7 as unknown as number),
  fchmodSync: mock(() => undefined),
  writeSync: mock(() => 0),
  fsyncSync: mock(() => undefined),
  closeSync: mock(() => undefined),
  constants: {
    O_WRONLY: 1,
    O_CREAT: 64,
    O_EXCL: 128,
  },
};
mock.module('node:fs', () => ({
  default: fsMocks,
  ...fsMocks,
}));
mock.module('node:child_process', () => ({
  default: { execFileSync: mock(() => '') },
  execFileSync: mock(() => ''),
}));
mock.module('node:os', () => ({
  default: { homedir: () => '/mock-home' },
  homedir: () => '/mock-home',
}));

import fs from 'node:fs';
import {
  checkForUpdate,
  setDevBuildCliEntry,
  type CachedCheck,
} from '@myco/daemon/update-checker.js';
import { mycoReleasesApiUrl } from '@myco/upgrade/release-assets.js';
import { UPDATE_CONFIG_PATH } from '@myco/constants/update.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal GitHub release shape for test fixtures. */
interface FakeRelease {
  tag_name: string;
  prerelease: boolean;
  assets: [];
}

function makeGitHubRelease(tagName: string, prerelease: boolean): FakeRelease {
  return { tag_name: tagName, prerelease, assets: [] };
}

function makeNpmRegistryResponse(latest: string, beta?: string): Record<string, unknown> {
  return {
    'dist-tags': {
      latest,
      ...(beta !== undefined ? { beta } : {}),
    },
  };
}

/** Build a minimal CachedCheck for fallback tests. */
function makeCachedCheck(overrides: Partial<CachedCheck> = {}): CachedCheck {
  return {
    checked_at: new Date().toISOString(),
    channel: 'stable',
    packages: {
      myco: { package_name: '@goondocks/myco', latest_stable: '1.1.0', latest_beta: null },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The GitHub releases API URL (used to route fetch calls)
// ---------------------------------------------------------------------------

const GITHUB_RELEASES_URL = mycoReleasesApiUrl();
const TEAM_NPM_URL = 'https://registry.npmjs.org/%40goondocks%2Fmyco-team';
const COLLECTIVE_NPM_URL = 'https://registry.npmjs.org/%40goondocks%2Fmyco-collective';

/**
 * Wire up global.fetch to dispatch per-URL:
 *   - GitHub releases URL → returns the provided releases array
 *   - npm registry URLs   → returns makeNpmRegistryResponse per-package
 */
function mockFetchPerUrl(opts: {
  githubReleases: FakeRelease[];
  teamLatest?: string;
  collectiveLatest?: string;
  githubStatus?: number;
}): void {
  const { githubReleases, teamLatest, collectiveLatest, githubStatus = 200 } = opts;

  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url === GITHUB_RELEASES_URL) {
      if (githubStatus !== 200) {
        return Promise.resolve({ ok: false, status: githubStatus, json: async () => [] });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => githubReleases,
      });
    }

    if (url === TEAM_NPM_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => makeNpmRegistryResponse(teamLatest ?? '2.0.0'),
      });
    }

    if (url === COLLECTIVE_NPM_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => makeNpmRegistryResponse(collectiveLatest ?? '3.0.0'),
      });
    }

    return Promise.reject(new Error(`Unexpected URL in test: ${url}`));
  });
}

/** Helper: make all file reads throw ENOENT. */
function mockNoFiles(): void {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
  });
  vi.mocked(fs.statSync).mockImplementation((p) => {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('MYCO_HOME', '/mock-home/.myco');
  setDevBuildCliEntry(null);
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.statSync).mockImplementation((p) => {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
  });
  vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
  mockNoFiles();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setDevBuildCliEntry(null);
  delete process.env.MYCO_HOME;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkForUpdate() — myco resolves from GitHub Releases', () => {
  it('myco row uses GitHub latest_stable, ignores sibling package tags', async () => {
    mockFetchPerUrl({
      githubReleases: [
        makeGitHubRelease('myco/v1.4.0', false),
        makeGitHubRelease('myco/v1.3.0-beta.1', true),
        makeGitHubRelease('myco/v1.5.0-beta.2', true),
        makeGitHubRelease('myco-team/v9.9.9', false),       // sibling — must be excluded
        makeGitHubRelease('myco-collective/v8.0.0', false), // sibling — must be excluded
      ],
    });

    const result = await checkForUpdate('1.0.0');
    const mycoRow = result.packages.find((p) => p.id === 'myco');

    expect(mycoRow?.latest_stable).toBe('1.4.0');
    expect(mycoRow?.latest_beta).toBe('1.5.0-beta.2');
  });

  it('up to date when running version matches GitHub stable', async () => {
    mockFetchPerUrl({
      githubReleases: [makeGitHubRelease('myco/v1.4.0', false)],
    });

    const result = await checkForUpdate('1.4.0');
    const mycoRow = result.packages.find((p) => p.id === 'myco');

    expect(mycoRow?.update_available).toBe(false);
    expect(result.update_available).toBe(false);
  });

  it('update available when GitHub has higher stable version', async () => {
    mockFetchPerUrl({
      githubReleases: [makeGitHubRelease('myco/v2.0.0', false)],
    });

    const result = await checkForUpdate('1.0.0');
    const mycoRow = result.packages.find((p) => p.id === 'myco');

    expect(mycoRow?.update_available).toBe(true);
    expect(result.update_available).toBe(true);
    expect(result.latest_stable).toBe('2.0.0');
    expect(result.latest_version).toBe('2.0.0');
  });

  it('no-downgrade: beta channel picks stable v1.4.0 over prerelease v1.3.0-beta.1', async () => {
    // Set channel to beta via update.yaml (matching the existing test convention)
    const content = 'channel: beta\ncheck_interval_hours: 6\n';
    vi.mocked(fs.existsSync).mockImplementation((p) => p === UPDATE_CONFIG_PATH);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === UPDATE_CONFIG_PATH) return content;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.statSync).mockImplementation((p) => {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    mockFetchPerUrl({
      githubReleases: [
        makeGitHubRelease('myco/v1.4.0', false),       // stable: higher
        makeGitHubRelease('myco/v1.3.0-beta.1', true), // prerelease: lower
      ],
    });

    const result = await checkForUpdate('1.0.0');
    const mycoRow = result.packages.find((p) => p.id === 'myco');

    // beta channel: max(stable, beta) = 1.4.0 (no-downgrade)
    expect(mycoRow?.latest_stable).toBe('1.4.0');
    expect(mycoRow?.latest_beta).toBe('1.3.0-beta.1');
    expect(result.latest_version).toBe('1.4.0');
    expect(result.channel).toBe('beta');
  });

  it('beta channel picks genuine higher prerelease over stable', async () => {
    // Set channel to beta via update.yaml (matching the existing test convention)
    const content = 'channel: beta\ncheck_interval_hours: 6\n';
    vi.mocked(fs.existsSync).mockImplementation((p) => p === UPDATE_CONFIG_PATH);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === UPDATE_CONFIG_PATH) return content;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.statSync).mockImplementation((p) => {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    mockFetchPerUrl({
      githubReleases: [
        makeGitHubRelease('myco/v1.4.0', false),       // stable
        makeGitHubRelease('myco/v1.5.0-beta.2', true), // prerelease: higher
      ],
    });

    const result = await checkForUpdate('1.0.0');

    expect(result.latest_version).toBe('1.5.0-beta.2');
    expect(result.latest_beta).toBe('1.5.0-beta.2');
    expect(result.update_available).toBe(true);
  });

  it('myco-team and myco-collective rows come from npm registry', async () => {
    mockFetchPerUrl({
      githubReleases: [makeGitHubRelease('myco/v1.0.0', false)],
      teamLatest: '5.0.0',
      collectiveLatest: '6.0.0',
    });

    const result = await checkForUpdate('1.0.0');
    const teamRow = result.packages.find((p) => p.id === 'myco-team');
    const collectiveRow = result.packages.find((p) => p.id === 'myco-collective');

    expect(teamRow?.latest_stable).toBe('5.0.0');
    expect(collectiveRow?.latest_stable).toBe('6.0.0');
  });

  it('CheckResult shape is unchanged (all required fields present)', async () => {
    mockFetchPerUrl({
      githubReleases: [makeGitHubRelease('myco/v1.2.0', false)],
    });

    const result = await checkForUpdate('1.0.0');

    expect(typeof result.update_available).toBe('boolean');
    expect(typeof result.revert_available).toBe('boolean');
    expect(typeof result.running_version).toBe('string');
    expect(typeof result.latest_version).toBe('string');
    expect(typeof result.latest_stable).toBe('string');
    expect(result.channel_scope).toBe('machine');
    expect(typeof result.check_interval_hours).toBe('number');
    expect(typeof result.last_check).toBe('string');
    expect(Array.isArray(result.packages)).toBe(true);
    expect(result.packages.length).toBe(3); // myco + myco-team + myco-collective
  });

  it('beta-only GitHub releases: latest_stable falls back to currentVersion', async () => {
    // No stable releases — resolveMycoVersions returns latest_stable=null
    // The ?? currentVersion fallback must kick in
    mockFetchPerUrl({
      githubReleases: [makeGitHubRelease('myco/v1.0.0-beta.1', true)],
    });

    const result = await checkForUpdate('0.9.0');
    const mycoRow = result.packages.find((p) => p.id === 'myco');

    expect(mycoRow?.latest_stable).toBe('0.9.0'); // fallback to currentVersion
    expect(mycoRow?.latest_beta).toBe('1.0.0-beta.1');
  });

  it('GitHub !response.ok flows into Promise.allSettled error path (returns error in result)', async () => {
    mockFetchPerUrl({ githubReleases: [], githubStatus: 429 });

    const result = await checkForUpdate('1.0.0');

    // The GitHub 429 for myco is a settled rejection; myco-team and myco-collective
    // may succeed or not. Either way, the error should be captured.
    expect(result.error).toMatch(/429/);
    expect(result.update_available).toBe(false);
  });

  it('fetch URL for myco is GitHub, not npm registry', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === GITHUB_RELEASES_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [makeGitHubRelease('myco/v1.0.0', false)],
        });
      }
      // npm URLs for operator CLIs
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => makeNpmRegistryResponse('1.0.0'),
      });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await checkForUpdate('1.0.0');

    const calls = (fetchSpy.mock.calls as Array<[string]>).map(([url]) => url);
    // myco MUST go to GitHub
    expect(calls).toContain(GITHUB_RELEASES_URL);
    // myco MUST NOT go to npm
    expect(calls).not.toContain('https://registry.npmjs.org/%40goondocks%2Fmyco');
  });
});
