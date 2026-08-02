/**
 * Tests for `myco upgrade` CLI command (cli/upgrade.ts).
 *
 * Critical flows covered:
 *   1. Arg parsing: --now / --check / --target-version <v> / <version> positional /
 *      --channel <stable|beta>
 *   2. --check calls the checker + prints, NEVER calls stage or adopt
 *   3. bare `myco upgrade` / `--now`: resolves channel target → stages → initiateAdopt
 *   4. `myco upgrade <version>` / `--target-version <v>`: resolves specific version refs
 *      (owned here, via the fetchReleases → exact-match path)
 *   5. Dev-build is refused (exits non-zero) — --check still reports
 *   6. --channel persists before resolving; beta→stable revert adopts stable
 *   7. win32 adopt: initiateAdopt is called with source='cli' (the re-exec is
 *      internal to adopt.ts; we verify opts here)
 *
 * All I/O (network, fs writes, daemon comms) is injected via UpgradeDeps.
 * The test never hits GitHub or the real filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

// ---------------------------------------------------------------------------
// Module mocks (must precede import of the module under test)
// ---------------------------------------------------------------------------

// Stub update-checker so writeProjectReleaseChannel doesn't touch real fs.
mock.module('@myco/daemon/update-checker.js', () => ({
  readProjectReleaseChannel: () => 'stable',
  writeProjectReleaseChannel: (_vaultDir: string, _channel: string) => { /* no-op */ },
}));

// Mock grove/paths so resolveMycoHome doesn't touch the real filesystem.
mock.module('@myco/grove/paths.js', () => ({
  resolveMycoHome: () => '/fake/myco-home',
  resolveGlobalConfigPath: () => '/fake/myco-home/config.yaml',
}));

// Mock service-state so resolveGlobalDaemonPort doesn't spawn processes.
mock.module('@myco/daemon/service-state.js', () => ({
  resolveGlobalDaemonPort: () => 20915,
}));

// Mock managed-binary so managedBinaryPath doesn't compute a real path.
mock.module('@myco/install/managed-binary.js', () => ({
  managedBinaryPath: (home: string, platform: string) =>
    platform === 'win32' ? `${home}\\AppData\\Local\\Myco\\bin\\myco.exe` : `${home}/.myco/bin/myco`,
}));

// Mock service/manager and daemon/api/restart for resolveRestartServiceLabel.
mock.module('@myco/service/manager.js', () => ({
  getServiceManager: () => ({ type: 'none' }),
}));

mock.module('@myco/daemon/api/restart.js', () => ({
  resolveRestartServiceLabel: async () => null,
}));

// import AFTER mocks
import { run, type UpgradeDeps } from '@myco/cli/upgrade.js';
import type { GitHubRelease, AssetRefs } from '@myco/upgrade/release-assets.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRelease(tag: string, prerelease: boolean): GitHubRelease {
  return {
    tag_name: tag,
    prerelease,
    assets: [
      {
        name: 'myco-darwin-arm64',
        browser_download_url: `https://dl.test/${tag}/myco-darwin-arm64`,
      },
      {
        name: 'SHA256SUMS',
        browser_download_url: `https://dl.test/${tag}/SHA256SUMS`,
      },
    ],
  };
}

function makeRefs(version: string): AssetRefs {
  return {
    assetUrl: `https://dl.test/myco/v${version}/myco-darwin-arm64`,
    sha256sumsUrl: `https://dl.test/myco/v${version}/SHA256SUMS`,
    assetName: 'myco-darwin-arm64',
    targetVersion: version,
  };
}

/** Deps that override everything network/fs-touching. */
function makeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    currentVersion: '1.0.0',
    home: '/fake/home',
    platform: 'linux',
    localAppData: undefined,
    daemonPort: 20915,
    mycoBinary: '/fake/home/.myco/bin/myco',
    projectRoot: '/fake/project',
    // Pin the target triple so exact-version asset resolution is deterministic
    // regardless of the host OS. The mock releases only include myco-darwin-arm64,
    // so we always resolve against that triple.
    targetTriple: () => 'darwin-arm64',
    // resolveRefs as vi.fn() so tests can assert on it with .toHaveBeenCalled etc.
    resolveRefs: vi.fn(async (_channel) => makeRefs('1.1.0')),
    fetchReleases: vi.fn(async () => [
      makeRelease('myco/v1.0.0', false),
      makeRelease('myco/v1.1.0', false),
      makeRelease('myco/v1.2.0-beta.1', true),
    ]),
    stageBinary: vi.fn(async (_params, _deps) => ({
      versionDir: '/fake/home/.myco/bin/versions/1.1.0',
      version: '1.1.0',
    })),
    initiateAdopt: vi.fn(async (_opts) => {}),
    writeChannel: vi.fn((_vaultDir, _channel) => {}),
    // checkFn stubbed so `--check` NEVER hits the real GitHub releases API —
    // resolveMycoPackageCheck defaults to `globalThis.fetch`, which hangs on CI.
    // Returns a deterministic up-to-date result (report-only path; no stage/adopt).
    checkFn: vi.fn(async (_current, _channel, _installed) => ({
      id: 'myco' as const,
      display_name: 'Myco',
      package_name: '@goondocks/myco',
      installed: true,
      installed_version: '1.0.0',
      latest_version: '1.0.0',
      latest_stable: '1.0.0',
      latest_beta: null,
      update_available: false,
      revert_available: false,
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Spy on process.exit so tests don't actually exit
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}__`);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  mock.restore();
});

// ---------------------------------------------------------------------------
// 1. Arg parsing
// ---------------------------------------------------------------------------

describe('myco upgrade: arg parsing', () => {
  it('--now is accepted and upgrades (equivalent to bare upgrade)', async () => {
    const deps = makeDeps();
    await run(['--now'], deps);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
  });

  it('--check is accepted and triggers report-only path', async () => {
    const deps = makeDeps({
      resolveRefs: async () => makeRefs('1.1.0'),
    });
    // --check exits via resolveMycoPackageCheck; we mock it so it doesn't hit network.
    // Since we didn't mock checker.ts here, we verify that stage+adopt are NOT called.
    // Wrap in try/catch because resolveMycoPackageCheck may throw (no network).
    try {
      await run(['--check'], deps);
    } catch {
      // May throw from real checker.ts hitting a missing fetch; that's fine.
    }
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('--target-version <v> is parsed and uses exact version path', async () => {
    const deps = makeDeps();
    await run(['--target-version', '1.1.0'], deps);
    // Should use fetchReleases path (exact match), not resolveRefs
    expect(deps.fetchReleases).toHaveBeenCalledTimes(1);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
    const stageCall = (deps.stageBinary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      refs: AssetRefs;
    };
    expect(stageCall.refs.targetVersion).toBe('1.1.0');
  });

  it('positional <version> is parsed and uses exact version path', async () => {
    const deps = makeDeps();
    await run(['1.1.0'], deps);
    expect(deps.fetchReleases).toHaveBeenCalledTimes(1);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
  });

  it('--target-version wins over positional', async () => {
    const deps = makeDeps({
      fetchReleases: async () => [
        makeRelease('myco/v1.1.0', false),
        makeRelease('myco/v1.2.0', false),
      ],
      stageBinary: vi.fn(async (_params, _deps) => ({
        versionDir: '/fake/home/.myco/bin/versions/1.1.0',
        version: '1.1.0',
      })),
    });
    await run(['--target-version', '1.1.0', '1.2.0'], deps);
    const stageCall = (deps.stageBinary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      refs: AssetRefs;
    };
    expect(stageCall.refs.targetVersion).toBe('1.1.0');
  });

  it('--channel <stable|beta> is accepted', async () => {
    const deps = makeDeps();
    await run(['--channel', 'beta'], deps);
    // Should have called resolveRefs (channel path), not fetchReleases
    expect(deps.resolveRefs).toHaveBeenCalledTimes(1);
    expect((deps.resolveRefs as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('beta');
  });

  it('rejects invalid channel', async () => {
    const deps = makeDeps();
    await expect(run(['--channel', 'nightly'], deps)).rejects.toThrow('__exit__');
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toContain("--channel must be 'stable' or 'beta'");
  });

  it('rejects invalid semver for positional', async () => {
    const deps = makeDeps();
    await expect(run(['not-a-version'], deps)).rejects.toThrow('__exit__');
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toContain('must be a strict semver');
  });

  it('rejects invalid semver for --target-version', async () => {
    const deps = makeDeps();
    await expect(run(['--target-version', 'not-a-version'], deps)).rejects.toThrow('__exit__');
  });

  it('--help outputs usage and returns', async () => {
    const deps = makeDeps();
    await run(['--help'], deps);
    expect(stdoutSpy).toHaveBeenCalled();
    const out = (stdoutSpy as ReturnType<typeof vi.fn>).mock.calls.flat().join('');
    expect(out).toContain('Usage: myco upgrade');
    expect(deps.stageBinary).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. --check path: calls checker + prints, NEVER stage/adopt
// ---------------------------------------------------------------------------

describe('myco upgrade --check', () => {
  it('does NOT call stageBinary or initiateAdopt', async () => {
    const deps = makeDeps();
    // checker.ts will throw in test (no network) — that's fine, just verify no stage/adopt
    try {
      await run(['--check'], deps);
    } catch {
      // May throw from process.exit(1) in the catch block of runCheck
    }
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('--check never stages or adopts even when a newer version is available', async () => {
    // checkFn dep short-circuits the live network call so the test stays hermetic.
    const fakeCheckResult = {
      update_available: true,
      latest_version: '1.1.0',
      revert_available: false,
      latest_stable: '1.1.0',
    };
    const deps = makeDeps({ checkFn: vi.fn(async () => fakeCheckResult) as unknown as UpgradeDeps['checkFn'] });
    await run(['--check'], deps);
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('positive: calls checkFn + prints update available + never stages or adopts', async () => {
    const fakeCheckResult = {
      update_available: true,
      latest_version: '1.2.0',
      revert_available: false,
      latest_stable: '1.1.0',
    };
    const checkFn = vi.fn(async () => fakeCheckResult);
    const deps = makeDeps({ checkFn: checkFn as unknown as UpgradeDeps['checkFn'] });

    await run(['--check'], deps);

    expect(checkFn).toHaveBeenCalledTimes(1);
    const logOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(logOutput).toContain('1.2.0');
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('positive: calls checkFn with correct channel when --channel is passed', async () => {
    const fakeCheckResult = {
      update_available: false,
      latest_version: '1.0.0',
      revert_available: false,
      latest_stable: '1.0.0',
    };
    const checkFn = vi.fn(async () => fakeCheckResult);
    const deps = makeDeps({ checkFn: checkFn as unknown as UpgradeDeps['checkFn'] });

    await run(['--check', '--channel', 'beta'], deps);

    expect(checkFn).toHaveBeenCalledTimes(1);
    // checkFn receives channel as second arg
    const callArgs = (checkFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, string];
    expect(callArgs[1]).toBe('beta');
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. bare `myco upgrade` / --now: channel resolve → stage → adopt inline
// ---------------------------------------------------------------------------

describe('myco upgrade (bare / --now): check → stage → initiateAdopt', () => {
  it('bare: resolves channel target, stages, adopts', async () => {
    const refs = makeRefs('1.1.0');
    const deps = makeDeps({
      currentVersion: '1.0.0',
      resolveRefs: vi.fn(async () => refs),
    });
    await run([], deps);

    expect(deps.resolveRefs).toHaveBeenCalledTimes(1);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
    const stageParam = (deps.stageBinary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      refs: AssetRefs;
      home: string;
      platform: NodeJS.Platform;
    };
    expect(stageParam.refs).toEqual(refs);
    expect(stageParam.home).toBe('/fake/home');
    expect(stageParam.platform).toBe('linux');

    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
    const adoptOpts = (deps.initiateAdopt as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      source: string;
      targetVersion: string;
      prevVersion: string;
    };
    expect(adoptOpts.source).toBe('cli');
    expect(adoptOpts.targetVersion).toBe('1.1.0');
    expect(adoptOpts.prevVersion).toBe('1.0.0');
  });

  it('--now: identical behaviour to bare', async () => {
    const deps = makeDeps();
    await run(['--now'], deps);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
  });

  it('exits cleanly when channel target matches current (already up to date)', async () => {
    const deps = makeDeps({
      currentVersion: '1.1.0',
      resolveRefs: async () => makeRefs('1.1.0'),
    });
    await expect(run([], deps)).rejects.toThrow('__exit__0__');
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('exits cleanly when no channel release found (null refs)', async () => {
    const deps = makeDeps({
      resolveRefs: async () => null,
    });
    await expect(run([], deps)).rejects.toThrow('__exit__0__');
    expect(deps.stageBinary).not.toHaveBeenCalled();
  });

  it('exits 1 when stage fails', async () => {
    const deps = makeDeps({
      stageBinary: vi.fn(async () => ({ error: 'download failed' })),
    });
    await expect(run([], deps)).rejects.toThrow('__exit__1__');
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Exact-version resolution (owned by cli/upgrade.ts)
// ---------------------------------------------------------------------------

describe('myco upgrade <version> / --target-version: specific version refs', () => {
  it('resolves via fetchReleases → tag match → refs', async () => {
    const releases = [
      makeRelease('myco/v1.0.0', false),
      makeRelease('myco/v1.1.0', false),
    ];
    const deps = makeDeps({
      fetchReleases: vi.fn(async () => releases),
      stageBinary: vi.fn(async (_params, _deps) => ({
        versionDir: '/fake/versions/1.1.0',
        version: '1.1.0',
      })),
    });
    await run(['--target-version', '1.1.0'], deps);

    expect(deps.fetchReleases).toHaveBeenCalledTimes(1);
    // resolveRefs (channel-latest) should NOT be called
    expect(deps.resolveRefs).not.toHaveBeenCalled();

    const stageParam = (deps.stageBinary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      refs: AssetRefs;
    };
    expect(stageParam.refs.targetVersion).toBe('1.1.0');
    expect(stageParam.refs.assetUrl).toContain('myco/v1.1.0');
  });

  it('exits 1 when the exact version tag is not found', async () => {
    const deps = makeDeps({
      fetchReleases: async () => [makeRelease('myco/v1.0.0', false)],
    });
    await expect(run(['--target-version', '9.9.9'], deps)).rejects.toThrow('__exit__1__');
    expect(deps.stageBinary).not.toHaveBeenCalled();
  });

  it('positional version uses the exact-version path, not resolveRefs', async () => {
    const deps = makeDeps({
      fetchReleases: vi.fn(async () => [makeRelease('myco/v1.1.0', false)]),
    });
    await run(['1.1.0'], deps);
    expect(deps.fetchReleases).toHaveBeenCalledTimes(1);
    expect(deps.resolveRefs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. --channel: persists channel + beta→stable revert
// ---------------------------------------------------------------------------

describe('myco upgrade --channel', () => {
  it('calls resolveRefs with the provided channel', async () => {
    const deps = makeDeps({
      resolveRefs: vi.fn(async () => makeRefs('1.1.0-beta.1')),
    });
    await run(['--channel', 'beta'], deps);
    expect((deps.resolveRefs as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('beta');
  });

  it('persists channel via writeChannel BEFORE calling resolveRefs (on actual-upgrade path)', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      writeChannel: vi.fn((_vaultDir, channel) => { callOrder.push(`persist:${channel}`); }),
      resolveRefs: vi.fn(async (channel) => { callOrder.push(`resolve:${channel}`); return makeRefs('1.1.0-beta.1'); }),
    });
    await run(['--channel', 'beta'], deps);
    expect(deps.writeChannel).toHaveBeenCalledTimes(1);
    expect((deps.writeChannel as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe('beta');
    // persist must come before resolve
    expect(callOrder.indexOf('persist:beta')).toBeLessThan(callOrder.indexOf('resolve:beta'));
  });

  it('--check --channel beta does NOT persist (report-only, no side effects)', async () => {
    const fakeCheckResult = {
      update_available: false,
      latest_version: '1.0.0',
      revert_available: false,
      latest_stable: '1.0.0',
    };
    const checkFn = vi.fn(async () => fakeCheckResult);
    const deps = makeDeps({ checkFn: checkFn as unknown as UpgradeDeps['checkFn'] });
    await run(['--check', '--channel', 'beta'], deps);
    expect(deps.writeChannel).not.toHaveBeenCalled();
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('beta→stable revert: adopts even when stable < current beta', async () => {
    // Current is a beta; --channel stable targets an older stable. The no-downgrade
    // rule must NOT block this because channelArg is set (explicit channel switch).
    const deps = makeDeps({
      currentVersion: '1.1.0-beta.2',
      resolveRefs: vi.fn(async () => makeRefs('1.0.5')), // stable is "older" than the beta
      stageBinary: vi.fn(async () => ({ versionDir: '/v/1.0.5', version: '1.0.5' })),
    });
    await run(['--channel', 'stable'], deps);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
    const adoptOpts = (deps.initiateAdopt as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      targetVersion: string;
    };
    expect(adoptOpts.targetVersion).toBe('1.0.5');
  });

  it('explicit --target-version also bypasses the no-downgrade rule', async () => {
    // User explicitly requests an older version — respect it.
    const deps = makeDeps({
      currentVersion: '1.1.0',
      fetchReleases: async () => [makeRelease('myco/v1.0.5', false)],
      stageBinary: vi.fn(async () => ({ versionDir: '/v/1.0.5', version: '1.0.5' })),
    });
    await run(['--target-version', '1.0.5'], deps);
    expect(deps.stageBinary).toHaveBeenCalledTimes(1);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. initiateAdopt is called with source='cli'
// ---------------------------------------------------------------------------

describe('myco upgrade: adopt opts', () => {
  it('initiateAdopt receives source=cli, targetVersion, prevVersion, daemonPort', async () => {
    const deps = makeDeps({
      currentVersion: '1.0.0',
      daemonPort: 19344,
    });
    await run([], deps);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
    const opts = (deps.initiateAdopt as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      source: string;
      targetVersion: string;
      prevVersion: string;
      daemonPort: number;
    };
    expect(opts.source).toBe('cli');
    expect(opts.targetVersion).toBe('1.1.0');
    expect(opts.prevVersion).toBe('1.0.0');
    expect(opts.daemonPort).toBe(19344);
  });

  it('initiateAdopt is NOT called when stage fails', async () => {
    const deps = makeDeps({
      stageBinary: vi.fn(async () => ({ error: 'network timeout' })),
    });
    await expect(run([], deps)).rejects.toThrow('__exit__1__');
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('initiateAdopt is NOT called on --check', async () => {
    const deps = makeDeps();
    try {
      await run(['--check'], deps);
    } catch { /* expected */ }
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Downgrade schema-gap guard (explicit version / channel revert)
// ---------------------------------------------------------------------------

describe('myco upgrade <older-version>: schema-gap guard', () => {
  const OLD_RELEASES = [
    makeRelease('myco/v0.9.0', false),
    makeRelease('myco/v1.0.0', false),
  ];

  it('refuses across the gap: exit 1, nothing staged, message names versions + recovery', async () => {
    const deps = makeDeps({
      fetchReleases: vi.fn(async () => OLD_RELEASES),
      readMaxStampedSchemaVersion: vi.fn(() => 76),
      readSupportedSchemaVersion: vi.fn(() => 71),
    });

    await expect(run(['0.9.0'], deps)).rejects.toThrow('__exit__1__');

    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
    const stderrText = (stderrSpy.mock.calls as unknown as string[][]).map((c) => c[0]).join('\n');
    expect(stderrText).toContain('v76');
    expect(stderrText).toContain('v71');
    expect(stderrText).toContain('restore a backup');
  });

  it('refuses when the target has no stamp (unknown fails closed)', async () => {
    const deps = makeDeps({
      fetchReleases: vi.fn(async () => OLD_RELEASES),
      readMaxStampedSchemaVersion: vi.fn(() => 76),
      readSupportedSchemaVersion: vi.fn(() => null),
    });

    await expect(run(['0.9.0'], deps)).rejects.toThrow('__exit__1__');
    expect(deps.stageBinary).not.toHaveBeenCalled();
  });

  it('proceeds when the target\'s stamp covers the vault', async () => {
    const deps = makeDeps({
      fetchReleases: vi.fn(async () => OLD_RELEASES),
      stageBinary: vi.fn(async (_params, _deps) => ({
        versionDir: '/fake/versions/0.9.0',
        version: '0.9.0',
      })),
      readMaxStampedSchemaVersion: vi.fn(() => 76),
      readSupportedSchemaVersion: vi.fn(() => 76),
    });

    await run(['0.9.0'], deps);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
  });

  it('proceeds when no vault is readable (fresh install)', async () => {
    const deps = makeDeps({
      fetchReleases: vi.fn(async () => OLD_RELEASES),
      stageBinary: vi.fn(async (_params, _deps) => ({
        versionDir: '/fake/versions/0.9.0',
        version: '0.9.0',
      })),
      readMaxStampedSchemaVersion: vi.fn(() => null),
      readSupportedSchemaVersion: vi.fn(() => null),
    });

    await run(['0.9.0'], deps);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
  });

  it('forward upgrades with an unknown target stamp proceed without the vault scan', async () => {
    const deps = makeDeps({
      readMaxStampedSchemaVersion: vi.fn(() => { throw new Error('must not be called'); }),
      readSupportedSchemaVersion: vi.fn(() => null),
    });

    await run(['--target-version', '1.1.0'], deps);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
    expect(deps.readMaxStampedSchemaVersion).not.toHaveBeenCalled();
  });

  it('a KNOWN stamp below the vault refuses even when the target is version-higher (dev current)', async () => {
    const deps = makeDeps({
      currentVersion: '0.0.0-dev+1.2.13-72-gabc1234',
      fetchReleases: vi.fn(async () => [makeRelease('myco/v1.2.13', false)]),
      readMaxStampedSchemaVersion: vi.fn(() => 76),
      readSupportedSchemaVersion: vi.fn(() => 66),
    });

    await expect(run(['1.2.13'], deps)).rejects.toThrow('__exit__1__');
    expect(deps.stageBinary).not.toHaveBeenCalled();
    expect(deps.initiateAdopt).not.toHaveBeenCalled();
  });

  it('a KNOWN stamp at or above the vault proceeds on a version-higher target', async () => {
    const deps = makeDeps({
      currentVersion: '0.0.0-dev+1.2.13-72-gabc1234',
      fetchReleases: vi.fn(async () => [makeRelease('myco/v1.2.13', false)]),
      stageBinary: vi.fn(async (_params, _deps) => ({ versionDir: '/x/1.2.13', version: '1.2.13' })),
      readMaxStampedSchemaVersion: vi.fn(() => 76),
      readSupportedSchemaVersion: vi.fn(() => 76),
    });

    await run(['1.2.13'], deps);
    expect(deps.initiateAdopt).toHaveBeenCalledTimes(1);
  });
});
