/**
 * Tests for the update checker module.
 *
 * Covers:
 * - isUpdateExempt / setDevBuildCliEntry — dev-mode exemption via
 *   module-level state (replaces the old MYCO_CMD env-var dispatch)
 * - readUpdateConfig — defaults when missing, reads YAML when present
 * - isCacheStale — null cache, fresh cache, expired cache
 * - checkForUpdate — fetches registry, update detection, channel logic
 * - statusFromCache — builds CheckResult from cache without registry
 * - detectDevBuild — realpath comparison against npm global prefix
 * - resolveMycoBinary — dev CLI entry vs literal `myco` fallback
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { MS_PER_HOUR } from '@myco/constants/update.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use the mocked modules
// ---------------------------------------------------------------------------

mock.module('node:fs');
mock.module('node:child_process');
mock.module('node:os', () => ({
  default: {
    homedir: () => '/mock-home',
  },
}));

// The constants module re-exports paths based on os.homedir(). Since vitest
// hoists vi.mock calls before imports, mocking 'node:os' here ensures that
// the constants are computed against '/mock-home' when the module is first
// evaluated during tests.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  isUpdateExempt,
  setDevBuildCliEntry,
  getDevBuildCliEntry,
  resolveMycoBinary,
  readUpdateConfig,
  isCacheStale,
  checkForUpdate,
  statusFromCache,
  resolveGlobalPrefix,
  getInstalledVersion,
  detectDevBuild,
  type CachedCheck,
  type UpdateConfig,
} from '@myco/daemon/update-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a CachedCheck with sensible defaults for test isolation. */
function makeCachedCheck(overrides: Partial<CachedCheck> = {}): CachedCheck {
  return {
    checked_at: new Date().toISOString(),
    channel: 'stable',
    packages: {
      myco: {
        package_name: '@goondocks/myco',
        latest_stable: '1.1.0',
        latest_beta: null,
      },
    },
    ...overrides,
  };
}

/** Build a minimal npm registry response. */
function makeRegistryResponse(latest: string, beta?: string): Record<string, unknown> {
  return {
    'dist-tags': {
      latest,
      ...(beta !== undefined ? { beta } : {}),
    },
  };
}

/** Helper: mock fs.readFileSync to return specific content for a path. */
function mockFileContent(filePath: string, content: string): void {
  vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
    if (p === filePath) return content;
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
  });
}

/** Helper: make all file reads throw ENOENT. */
function mockNoFiles(): void {
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
  });
}

/** Helper: mock a successful fetch response. */
function mockFetchSuccess(data: Record<string, unknown>): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => data,
  } as Response);
}

/** Helper: mock a failed fetch. */
function mockFetchFailure(message = 'network error'): void {
  global.fetch = vi.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  // The dev-build CLI entry is module state — reset between tests so
  // a prior test's "set to dev" doesn't bleed into the next test's
  // "expect prod" assertion.
  setDevBuildCliEntry(null);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setDevBuildCliEntry(null);
});

// ---------------------------------------------------------------------------
// isUpdateExempt
// ---------------------------------------------------------------------------

describe('isUpdateExempt() / setDevBuildCliEntry() / getDevBuildCliEntry()', () => {
  it('returns false when no dev-build CLI entry has been recorded', () => {
    expect(isUpdateExempt()).toBe(false);
    expect(getDevBuildCliEntry()).toBeNull();
  });

  it('returns true after setDevBuildCliEntry records a path', () => {
    setDevBuildCliEntry('/Users/dev/.local/bin/myco-dev');
    expect(isUpdateExempt()).toBe(true);
    expect(getDevBuildCliEntry()).toBe('/Users/dev/.local/bin/myco-dev');
  });

  it('returns false after setDevBuildCliEntry(null) clears the state', () => {
    setDevBuildCliEntry('/Users/dev/.local/bin/myco-dev');
    setDevBuildCliEntry(null);
    expect(isUpdateExempt()).toBe(false);
    expect(getDevBuildCliEntry()).toBeNull();
  });

  it('ignores the legacy MYCO_CMD env var entirely', () => {
    // Regression guard: the old implementation returned true when
    // MYCO_CMD was set in the process environment. Dev-mode exemption
    // now flows through setDevBuildCliEntry exclusively — a stray
    // MYCO_CMD leaked from a parent shell must have no effect.
    vi.stubEnv('MYCO_CMD', 'myco-dev');
    expect(isUpdateExempt()).toBe(false);
  });
});

describe('resolveMycoBinary()', () => {
  it('returns the recorded dev-build CLI entry when set', () => {
    setDevBuildCliEntry('/Users/dev/.local/bin/myco-dev');
    expect(resolveMycoBinary()).toBe('/Users/dev/.local/bin/myco-dev');
  });

  it('returns the literal `myco` fallback when no dev entry is recorded', () => {
    expect(resolveMycoBinary()).toBe('myco');
  });
});

// ---------------------------------------------------------------------------
// readUpdateConfig
// ---------------------------------------------------------------------------

describe('readUpdateConfig()', () => {
  it('returns defaults when the config file is missing', () => {
    mockNoFiles();
    const config = readUpdateConfig();
    expect(config.channel).toBe('stable');
    expect(config.check_interval_hours).toBeGreaterThan(0);
  });

  it('reads channel from yaml when file exists', () => {
    mockFileContent(
      '/mock-home/.myco/update.yaml',
      'channel: beta\ncheck_interval_hours: 12\n',
    );
    const config = readUpdateConfig();
    expect(config.channel).toBe('beta');
    expect(config.check_interval_hours).toBe(12);
  });

  it('falls back to stable channel for unknown channel values', () => {
    mockFileContent(
      '/mock-home/.myco/update.yaml',
      'channel: nightly\ncheck_interval_hours: 6\n',
    );
    const config = readUpdateConfig();
    expect(config.channel).toBe('stable');
  });

  it('falls back to default interval for invalid interval value', () => {
    mockFileContent(
      '/mock-home/.myco/update.yaml',
      'channel: stable\ncheck_interval_hours: -5\n',
    );
    const config: UpdateConfig = readUpdateConfig();
    expect(config.check_interval_hours).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe('isCacheStale()', () => {
  it('returns true when cache is null', () => {
    expect(isCacheStale(null, 6)).toBe(true);
  });

  it('returns false when cache is fresh (just created)', () => {
    const fresh = makeCachedCheck({ checked_at: new Date().toISOString() });
    expect(isCacheStale(fresh, 6)).toBe(false);
  });

  it('returns true when cache is older than the interval', () => {
    const hoursAgo8 = new Date(Date.now() - 8 * MS_PER_HOUR).toISOString();
    const stale = makeCachedCheck({ checked_at: hoursAgo8 });
    expect(isCacheStale(stale, 6)).toBe(true);
  });

  it('returns false when cache age is exactly within the interval', () => {
    const hoursAgo4 = new Date(Date.now() - 4 * MS_PER_HOUR).toISOString();
    const recent = makeCachedCheck({ checked_at: hoursAgo4 });
    expect(isCacheStale(recent, 6)).toBe(false);
  });

  it('returns true when checked_at is not a valid date', () => {
    const bad = makeCachedCheck({ checked_at: 'not-a-date' });
    expect(isCacheStale(bad, 6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

describe('checkForUpdate()', () => {
  beforeEach(() => {
    // No pre-existing config or cache by default
    mockNoFiles();
  });

  it('fetches the registry and returns an update when a newer version exists', async () => {
    mockFetchSuccess(makeRegistryResponse('2.0.0'));

    const result = await checkForUpdate('1.0.0');

    expect(result.update_available).toBe(true);
    expect(result.running_version).toBe('1.0.0');
    expect(result.latest_stable).toBe('2.0.0');
    expect(result.latest_version).toBe('2.0.0');
    expect(result.error).toBeNull();
  });

  it('returns no update when running the latest version', async () => {
    mockFetchSuccess(makeRegistryResponse('1.0.0'));

    const result = await checkForUpdate('1.0.0');

    expect(result.update_available).toBe(false);
    expect(result.latest_stable).toBe('1.0.0');
    expect(result.error).toBeNull();
  });

  it('returns no update when running a newer version than registry (pre-release dev)', async () => {
    mockFetchSuccess(makeRegistryResponse('1.0.0'));

    const result = await checkForUpdate('2.0.0');

    expect(result.update_available).toBe(false);
  });

  it('writes cache after a successful fetch', async () => {
    mockFetchSuccess(makeRegistryResponse('1.5.0'));

    await checkForUpdate('1.0.0');

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();
    const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const cached = JSON.parse(writtenContent) as CachedCheck;
    expect(cached.packages.myco?.latest_stable).toBe('1.5.0');
  });

  describe('beta channel', () => {
    beforeEach(() => {
      // Config file returns beta channel
      mockFileContent(
        '/mock-home/.myco/update.yaml',
        'channel: beta\ncheck_interval_hours: 6\n',
      );
    });

    it('considers the beta dist-tag when on beta channel', async () => {
      mockFetchSuccess(makeRegistryResponse('1.0.0', '1.1.0-beta.1'));

      const result = await checkForUpdate('1.0.0');

      expect(result.update_available).toBe(true);
      expect(result.latest_version).toBe('1.1.0-beta.1');
      expect(result.latest_beta).toBe('1.1.0-beta.1');
    });

    it('picks stable over beta when stable is higher (no-downgrade rule)', async () => {
      // stable 2.0.0 > beta 1.9.0-beta.1
      mockFetchSuccess(makeRegistryResponse('2.0.0', '1.9.0-beta.1'));

      const result = await checkForUpdate('1.0.0');

      expect(result.update_available).toBe(true);
      expect(result.latest_version).toBe('2.0.0');
    });

    it('reports latest_beta even when not selected as target', async () => {
      mockFetchSuccess(makeRegistryResponse('2.0.0', '1.9.0-beta.1'));

      const result = await checkForUpdate('1.0.0');

      expect(result.latest_beta).toBe('1.9.0-beta.1');
    });

    it('sets channel to beta in the result', async () => {
      mockFetchSuccess(makeRegistryResponse('1.0.0', '1.1.0-beta.1'));

      const result = await checkForUpdate('1.0.0');

      expect(result.channel).toBe('beta');
    });
  });

  describe('stable channel', () => {
    it('ignores beta dist-tag on stable channel', async () => {
      // stable channel — beta tag should not be selected as target
      mockFetchSuccess(makeRegistryResponse('1.0.0', '1.5.0-beta.1'));

      const result = await checkForUpdate('1.0.0');

      expect(result.update_available).toBe(false);
      expect(result.latest_version).toBe('1.0.0');
      // But latest_beta is still reported
      expect(result.latest_beta).toBe('1.5.0-beta.1');
    });
  });

  describe('error handling', () => {
    it('returns cached result with error when fetch fails and cache exists', async () => {
      const staleCache = makeCachedCheck({
        channel: 'stable',
        packages: {
          myco: {
            package_name: '@goondocks/myco',
            latest_stable: '1.2.0',
            latest_beta: null,
          },
        },
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith('last-update-check.json')) {
          return JSON.stringify(staleCache);
        }
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
        err.code = 'ENOENT';
        throw err;
      });

      mockFetchFailure('fetch failed');

      const result = await checkForUpdate('1.0.0');

      expect(result.error).toMatch(/fetch failed/);
      expect(result.latest_stable).toBe('1.2.0');
    });

    it('returns no-update with error when fetch fails and no cache exists', async () => {
      mockNoFiles();
      mockFetchFailure('connection refused');

      const result = await checkForUpdate('1.0.0');

      expect(result.update_available).toBe(false);
      expect(result.error).toMatch(/connection refused/);
    });

    it('handles non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response);
      mockNoFiles();

      const result = await checkForUpdate('1.0.0');

      expect(result.update_available).toBe(false);
      expect(result.error).toMatch(/503/);
    });
  });
});

// ---------------------------------------------------------------------------
// statusFromCache
// ---------------------------------------------------------------------------

describe('statusFromCache()', () => {
  it('returns null when no cache file exists', () => {
    mockNoFiles();
    const result = statusFromCache('1.0.0');
    expect(result).toBeNull();
  });

  it('builds a CheckResult from cache when cache exists', () => {
    const cache = makeCachedCheck({
      channel: 'stable',
      checked_at: new Date().toISOString(),
      packages: {
        myco: {
          package_name: '@goondocks/myco',
          latest_stable: '1.5.0',
          latest_beta: null,
        },
      },
    });

    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('last-update-check.json')) {
        return JSON.stringify(cache);
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    const result = statusFromCache('1.0.0');

    expect(result).not.toBeNull();
    expect(result!.update_available).toBe(true);
    expect(result!.running_version).toBe('1.0.0');
    expect(result!.latest_stable).toBe('1.5.0');
    expect(result!.latest_version).toBe('1.5.0');
    expect(result!.channel).toBe('stable');
    expect(result!.error).toBeNull();
  });

  it('correctly detects no update from cache', () => {
    const cache = makeCachedCheck({
      channel: 'stable',
      packages: {
        myco: {
          package_name: '@goondocks/myco',
          latest_stable: '1.5.0',
          latest_beta: null,
        },
      },
    });

    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('last-update-check.json')) {
        return JSON.stringify(cache);
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    const result = statusFromCache('1.5.0');
    expect(result!.update_available).toBe(false);
  });

  it('uses beta channel logic when cache channel is beta', () => {
    const cache = makeCachedCheck({
      channel: 'beta',
      packages: {
        myco: {
          package_name: '@goondocks/myco',
          latest_stable: '1.0.0',
          latest_beta: '1.1.0-beta.1',
        },
      },
    });

    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('last-update-check.json')) {
        return JSON.stringify(cache);
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    const result = statusFromCache('1.0.0');
    expect(result!.update_available).toBe(true);
    expect(result!.latest_version).toBe('1.1.0-beta.1');
  });
});

// ---------------------------------------------------------------------------
// resolveGlobalPrefix
// ---------------------------------------------------------------------------

describe('resolveGlobalPrefix()', () => {
  it('returns trimmed stdout from npm prefix -g', () => {
    vi.mocked(execFileSync).mockReturnValue('/usr/local\n' as never);

    const prefix = resolveGlobalPrefix();
    expect(typeof prefix).toBe('string');
    expect(prefix).toBe('/usr/local');
    expect(execFileSync).toHaveBeenCalledWith('npm', ['prefix', '-g'], { encoding: 'utf-8', timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// getInstalledVersion
// ---------------------------------------------------------------------------

describe('getInstalledVersion()', () => {
  it('returns version string when package.json exists at expected path', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
      if (String(p).includes('@goondocks/myco/package.json')) {
        return JSON.stringify({ version: '1.2.3' });
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    const result = getInstalledVersion('/usr/local');
    expect(result).toBe('1.2.3');
  });

  it('returns null when package.json does not exist', () => {
    mockNoFiles();
    const result = getInstalledVersion('/usr/local');
    expect(result).toBeNull();
  });

  it('returns null when package.json is malformed', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
      if (String(p).includes('@goondocks/myco/package.json')) {
        return 'not json';
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    const result = getInstalledVersion('/usr/local');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectDevBuild
// ---------------------------------------------------------------------------

describe('detectDevBuild()', () => {
  /** Identity resolver — test paths don't exist, so bypass real realpath. */
  const identityResolver = (p: string) => p;

  it('returns null when globalPrefix is null', () => {
    const result = detectDevBuild(null, '/home/user/.local/bin/myco-dev', identityResolver);
    expect(result).toBeNull();
  });

  it('returns null when cliEntry is missing', () => {
    const result = detectDevBuild('/opt/homebrew', undefined, identityResolver);
    expect(result).toBeNull();
  });

  it('returns cliEntry when binary is outside global prefix (dev build)', () => {
    const result = detectDevBuild(
      '/opt/homebrew',
      '/home/user/.local/bin/myco-dev',
      identityResolver,
    );
    expect(result).toBe('/home/user/.local/bin/myco-dev');
  });

  it('returns null when binary is inside global prefix (proper install)', () => {
    const result = detectDevBuild(
      '/opt/homebrew',
      '/opt/homebrew/lib/node_modules/@goondocks/myco/dist/cli.js',
      identityResolver,
    );
    expect(result).toBeNull();
  });

  it('does not match on path prefix that is only a string prefix, not a path boundary', () => {
    // /opt/homebrew-foo should NOT be considered under /opt/homebrew
    const result = detectDevBuild(
      '/opt/homebrew',
      '/opt/homebrew-foo/bin/myco',
      identityResolver,
    );
    expect(result).toBe('/opt/homebrew-foo/bin/myco');
  });

  it('resolves symlinks via realpath before comparing', () => {
    // Simulate a symlink: /home/user/.local/bin/myco-dev → /opt/homebrew/lib/node_modules/...
    // If we followed the symlink, it would look like a proper install.
    const symlinkResolver = (p: string) => {
      if (p === '/home/user/.local/bin/myco-dev') {
        return '/opt/homebrew/lib/node_modules/@goondocks/myco/dist/cli.js';
      }
      return p;
    };

    const result = detectDevBuild(
      '/opt/homebrew',
      '/home/user/.local/bin/myco-dev',
      symlinkResolver,
    );
    expect(result).toBeNull();
  });

  it('returns null when realpath throws', () => {
    const throwingResolver = () => {
      throw new Error('ENOENT');
    };

    const result = detectDevBuild(
      '/opt/homebrew',
      '/home/user/.local/bin/myco-dev',
      throwingResolver,
    );
    expect(result).toBeNull();
  });
});
