/**
 * Tests for the update checker module (retained exports).
 *
 * Covers:
 * - isUpdateExempt / setDevBuildCliEntry — dev-mode exemption via
 *   module-level state (replaces the old MYCO_CMD env-var dispatch)
 * - readUpdateConfig — defaults when missing, reads YAML when present
 * - isCacheStale — null cache, fresh cache, expired cache
 * - detectDevBuild — realpath comparison against npm global prefix
 * - resolveMycoBinary — dev CLI entry vs literal `myco` fallback
 *
 * Note: checkForUpdate / statusFromCache were retired from update-checker.ts
 * (Task 7). The composite CheckResult assembly now lives in daemon/api/upgrade.ts.
 * Those functions' behaviors are covered by tests/daemon/api/upgrade.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { MS_PER_HOUR } from '@myco/constants/update.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use the mocked modules
// ---------------------------------------------------------------------------

// bun:test requires a factory for mock.module. Provide one that returns
// mock fns for every fs method touched by update-checker, wired under both
// the default export and named exports so `import fs from 'node:fs'` and
// destructured imports both see the same mocks.
const fsMocks = {
  existsSync: mock(() => false),
  readFileSync: mock(() => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
  // statSync gates the machine-config tier cache (readTierConfig keys on
  // mtime+size). Default throws ENOENT so missing files stay missing; the
  // mockFileContent/mockNoFiles helpers drive it in lockstep with readFileSync.
  statSync: mock(() => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
  realpathSync: mock((p: unknown) => String(p)),
  writeFileSync: mock(() => undefined),
  mkdirSync: mock(() => undefined),
  unlinkSync: mock(() => undefined),
  // atomicWriteFileSync writes to a temp path then renames. The release
  // channel writer flows through that helper now.
  renameSync: mock(() => undefined),
  // The Bucket H atomic-write refactor (H.1) replaced
  // writeFileSync+chmodSync with openSync(O_EXCL) + fchmodSync + writeSync
  // + fsyncSync + closeSync. The test only cares that the writer
  // reaches renameSync (the assertion on writtenContent reads from the
  // tempfile path, but here we just need the call chain not to throw on
  // an undefined method).
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
const execFileSyncMock = mock(() => '' as string | Buffer);
mock.module('node:child_process', () => ({
  default: { execFileSync: execFileSyncMock },
  execFileSync: execFileSyncMock,
}));
mock.module('node:os', () => ({
  default: {
    homedir: () => '/mock-home',
  },
  homedir: () => '/mock-home',
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
  resolveRuntimeCommand,
  readProjectReleaseChannel,
  writeProjectReleaseChannel,
  readUpdateConfig,
  isCacheStale,
  resolveGlobalPrefix,
  getInstalledVersion,
  getRuntimeVersionLabel,
  detectDevBuild,
  type CachedCheck,
  type UpdateConfig,
} from '@myco/daemon/update-checker.js';
import { UPDATE_CONFIG_PATH } from '@myco/constants/update.js';

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

/** Build a synthetic fs.Stats keyed by content so the machine-config tier
 *  cache invalidates whenever the mocked content changes (defends against
 *  cross-test machineConfigCache leakage — see readTierConfig).
 *
 *  `uid` and `mode` are set to pass the pin-trust check in `checkPinTrust`
 *  (uid = current process uid, mode = 0o100644 — owner rw, group/other r).
 *  Files that aren't pin files ignore these fields; files that ARE pin files
 *  must look trusted so existing resolveRuntimeCommand tests keep passing. */
function fakeStat(content: string): fs.Stats {
  return {
    mtimeMs: content.length + 1,
    size: content.length,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    mode: 0o100644,
  } as unknown as fs.Stats;
}

/** Helper: mock fs.readFileSync to return specific content for a path. */
function mockFileContent(filePath: string, content: string): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => p === filePath);
  vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
    if (p === filePath) return content;
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
  });
  vi.mocked(fs.statSync).mockImplementation((p) => {
    if (p === filePath) return fakeStat(content);
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
    err.code = 'ENOENT';
    throw err;
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
  // Pin MYCO_HOME for the test runner so `resolveMycoHome()` returns the
  // mocked path without depending on the (unmocked) transitive os.homedir()
  // import inside grove/paths.ts.
  vi.stubEnv('MYCO_HOME', '/mock-home/.myco');
  // The dev-build CLI entry is module state — reset between tests so
  // a prior test's "set to dev" doesn't bleed into the next test's
  // "expect prod" assertion.
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  setDevBuildCliEntry(null);
  // Belt-and-suspenders: bun:test --isolate doesn't actually fork between
  // test files, so a stubbed MYCO_HOME persisting after this file finishes
  // would leak into other tests' module loads. Force-clear it.
  delete process.env.MYCO_HOME;
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

describe('getRuntimeVersionLabel()', () => {
  it('uses the protocol version for stable runtimes', () => {
    expect(getRuntimeVersionLabel('/vault/.myco', '0.27.19')).toBe('0.27.19');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('describes dev runtimes from the nearest git release tag', () => {
    setDevBuildCliEntry('/repo/packages/myco-darwin-arm64/bin/myco');
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    vi.mocked(fs.existsSync).mockImplementation((p) => p === '/repo/.git');
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual([
        '-C',
        '/repo',
        'describe',
        '--tags',
        '--match',
        'v[0-9]*',
        '--always',
        '--dirty',
      ]);
      return 'v0.18.1-244-g63fe75a5-dirty\n';
    });

    expect(getRuntimeVersionLabel('/vault/.myco', '0.25.0')).toBe('v0.18.1-244-g63fe75a5-dirty');
  });

  it('falls back to a dev-suffixed protocol version when git metadata is unavailable', () => {
    setDevBuildCliEntry('/repo/packages/myco-darwin-arm64/bin/myco');
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(getRuntimeVersionLabel('/vault/.myco', '0.25.1')).toBe('0.25.1+dev');
  });
});

describe('resolveRuntimeCommand()', () => {
  it('returns the trimmed runtime.command value when present at ~/.myco/', () => {
    mockFileContent('/mock-home/.myco/runtime.command', '  /mock-home/.myco/runtime/node_modules/.bin/myco \n');
    expect(resolveRuntimeCommand()).toBe('/mock-home/.myco/runtime/node_modules/.bin/myco');
  });

  it('returns null when runtime.command is missing', () => {
    mockNoFiles();
    expect(resolveRuntimeCommand()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // E2: daemon-side pin trust check (mirrors runtime-redirect.cjs G7 guard)
  // ---------------------------------------------------------------------------

  it('E2: ignores a group-writable pin file (mode 0o664) and returns null', () => {
    if (process.platform === 'win32') return;
    const pinPath = '/mock-home/.myco/runtime.command';
    const content = '/opt/pinned/myco';
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === pinPath) {
        return {
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          mode: 0o100664, // group-writable — insecure
          mtimeMs: content.length + 1,
          size: content.length,
        } as unknown as fs.Stats;
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
      if (p === pinPath) return content;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    expect(resolveRuntimeCommand()).toBeNull();
  });

  it('E2: ignores an other-writable pin file (mode 0o666) and returns null', () => {
    if (process.platform === 'win32') return;
    const pinPath = '/mock-home/.myco/runtime.command';
    const content = '/opt/pinned/myco';
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === pinPath) {
        return {
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          mode: 0o100666, // other-writable — insecure
          mtimeMs: content.length + 1,
          size: content.length,
        } as unknown as fs.Stats;
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
      if (p === pinPath) return content;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    expect(resolveRuntimeCommand()).toBeNull();
  });

  it('E2: honors a trusted pin file (mode 0o644, owned by current uid)', () => {
    if (process.platform === 'win32') return;
    const pinPath = '/mock-home/.myco/runtime.command';
    const content = '/opt/pinned/myco';
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === pinPath) {
        return {
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          mode: 0o100644, // owner rw, group/other read-only — trusted
          mtimeMs: content.length + 1,
          size: content.length,
        } as unknown as fs.Stats;
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
      if (p === pinPath) return content;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    expect(resolveRuntimeCommand()).toBe('/opt/pinned/myco');
  });

  it('E2: ignores a pin file owned by a different uid and returns null', () => {
    if (process.platform === 'win32') return;
    if (typeof process.getuid !== 'function') return;
    const pinPath = '/mock-home/.myco/runtime.command';
    const content = '/opt/pinned/myco';
    const foreignUid = process.getuid() === 0 ? 1 : 0; // pick a uid that isn't ours
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === pinPath) {
        return {
          uid: foreignUid,
          mode: 0o100644,
          mtimeMs: content.length + 1,
          size: content.length,
        } as unknown as fs.Stats;
      }
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p, _opts) => {
      if (p === pinPath) return content;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    expect(resolveRuntimeCommand()).toBeNull();
  });
});

describe('release channel helpers (machine-scoped, decision-46130740)', () => {
  // The effective channel is `daemon.update_channel` at MACHINE scope.
  // There is no project/personal override: a stray `update.channel` in a
  // project local.yaml is ignored. Machine config lives at
  // `<MYCO_HOME>/config.yaml` — here `/mock-home/.myco/config.yaml`.
  const MACHINE_CONFIG_PATH = '/mock-home/.myco/config.yaml';

  it('defaults to stable when machine config has no channel', () => {
    mockNoFiles();
    expect(readProjectReleaseChannel('/vault/.myco')).toBe('stable');
  });

  it('reads daemon.update_channel from machine config', () => {
    mockFileContent(MACHINE_CONFIG_PATH, 'daemon:\n  update_channel: beta\n');
    expect(readProjectReleaseChannel('/vault/.myco')).toBe('beta');
  });

  it('ignores a legacy update.channel sitting in project local.yaml', () => {
    // Pre-migration, the channel was a per-project override in local.yaml.
    // Post decision-46130740 the machine value wins and local.yaml is not
    // consulted — a stray local override must NOT change the channel.
    mockFileContent('/vault/.myco/local.yaml', 'update:\n  channel: beta\n');
    expect(readProjectReleaseChannel('/vault/.myco')).toBe('stable');
  });

  it('machine config wins over a legacy update.channel in local.yaml', () => {
    const localPath = '/vault/.myco/local.yaml';
    const localContent = 'update:\n  channel: stable\n';
    const machineContent = 'daemon:\n  update_channel: beta\n';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === localPath || p === MACHINE_CONFIG_PATH,
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === localPath) return localContent;
      if (p === MACHINE_CONFIG_PATH) return machineContent;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === localPath) return fakeStat(localContent);
      if (p === MACHINE_CONFIG_PATH) return fakeStat(machineContent);
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(p)}`);
      err.code = 'ENOENT';
      throw err;
    });

    expect(readProjectReleaseChannel('/vault/.myco')).toBe('beta');
  });

  it('writes beta to machine config daemon.update_channel', () => {
    mockNoFiles();

    writeProjectReleaseChannel('/vault/.myco', 'beta');

    // saveMachineConfig flows through the atomic writer (openSync(O_EXCL) →
    // writeSync → fsyncSync → closeSync → renameSync) targeting the machine
    // config.yaml tempfile sibling. Assert the rename lands on the machine
    // config path and the written buffer carries the channel marker.
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock-home\/\.myco\/config\.yaml\.tmp-/),
      MACHINE_CONFIG_PATH,
    );
    const writeCalls = vi.mocked(fs.writeSync).mock.calls;
    const wroteBeta = writeCalls.some(([, buf]) => {
      const text = buf instanceof Buffer ? buf.toString('utf-8') : String(buf);
      return text.includes('update_channel: beta');
    });
    expect(wroteBeta).toBe(true);
  });

  it('does NOT write update.channel into project local.yaml', () => {
    mockNoFiles();

    writeProjectReleaseChannel('/vault/.myco', 'beta');

    // The retired path wrote `<vault>/.myco/local.yaml`. The machine-scoped
    // writer must never touch the project local.yaml tempfile.
    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    const touchedLocalYaml = renameCalls.some(
      ([, dest]) => dest === '/vault/.myco/local.yaml',
    );
    expect(touchedLocalYaml).toBe(false);
  });

  it('writes stable to machine config daemon.update_channel', () => {
    mockFileContent(MACHINE_CONFIG_PATH, 'daemon:\n  update_channel: beta\n');

    writeProjectReleaseChannel('/vault/.myco', 'stable');

    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock-home\/\.myco\/config\.yaml\.tmp-/),
      MACHINE_CONFIG_PATH,
    );
    const writeCalls = vi.mocked(fs.writeSync).mock.calls;
    const wroteStable = writeCalls.some(([, buf]) => {
      const text = buf instanceof Buffer ? buf.toString('utf-8') : String(buf);
      return text.includes('update_channel: stable');
    });
    expect(wroteStable).toBe(true);
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
      UPDATE_CONFIG_PATH,
      'channel: beta\ncheck_interval_hours: 12\n',
    );
    const config = readUpdateConfig();
    expect(config.channel).toBe('beta');
    expect(config.check_interval_hours).toBe(12);
  });

  it('falls back to stable channel for unknown channel values', () => {
    mockFileContent(
      UPDATE_CONFIG_PATH,
      'channel: nightly\ncheck_interval_hours: 6\n',
    );
    const config = readUpdateConfig();
    expect(config.channel).toBe('stable');
  });

  it('falls back to default interval for invalid interval value', () => {
    mockFileContent(
      UPDATE_CONFIG_PATH,
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
