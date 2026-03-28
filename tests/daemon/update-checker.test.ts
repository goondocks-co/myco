/**
 * Tests for the update checker module.
 *
 * Covers:
 * - isUpdateExempt — dev-mode detection via MYCO_CMD
 * - readUpdateConfig — defaults when missing, reads YAML when present
 * - isCacheStale — null cache, fresh cache, expired cache
 * - checkForUpdate — fetches registry, update detection, channel logic
 * - statusFromCache — builds CheckResult from cache without registry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MS_PER_HOUR } from '../../src/constants/update.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use the mocked modules
// ---------------------------------------------------------------------------

vi.mock('node:fs');
vi.mock('node:os', () => ({
  default: {
    homedir: () => '/mock-home',
  },
}));

// The constants module re-exports paths based on os.homedir(). Since vitest
// hoists vi.mock calls before imports, mocking 'node:os' here ensures that
// the constants are computed against '/mock-home' when the module is first
// evaluated during tests.

import fs from 'node:fs';
import {
  isUpdateExempt,
  readUpdateConfig,
  isCacheStale,
  checkForUpdate,
  statusFromCache,
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
    current_version: '1.0.0',
    latest_stable: '1.1.0',
    latest_beta: null,
    channel: 'stable',
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
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// isUpdateExempt
// ---------------------------------------------------------------------------

describe('isUpdateExempt()', () => {
  it('returns false when MYCO_CMD is not set', () => {
    vi.stubEnv('MYCO_CMD', '');
    expect(isUpdateExempt()).toBe(false);
  });

  it('returns true when MYCO_CMD is set', () => {
    vi.stubEnv('MYCO_CMD', 'myco-dev');
    expect(isUpdateExempt()).toBe(true);
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
    expect(cached.latest_stable).toBe('1.5.0');
    expect(cached.current_version).toBe('1.0.0');
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
        latest_stable: '1.2.0',
        channel: 'stable',
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
      latest_stable: '1.5.0',
      latest_beta: null,
      channel: 'stable',
      checked_at: new Date().toISOString(),
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
      current_version: '1.5.0',
      latest_stable: '1.5.0',
      latest_beta: null,
      channel: 'stable',
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
      latest_stable: '1.0.0',
      latest_beta: '1.1.0-beta.1',
      channel: 'beta',
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
