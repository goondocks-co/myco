import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type UpgradeDeps } from '@myco/cli/update.js';
import { run as alias } from '@myco/cli/upgrade.js';
import { placeExecutable } from '@myco/install/place-binary.js';
import { writeInstallMarker } from '@myco/install/managed-binary.js';
import { publishAdoptedMarker } from '@myco/install/adoption.js';
import { readInstallMarker } from '@myco/install/marker-reader.js';
import { readUpdateNotice } from '@myco/upgrade/check-cache.js';
import { resolveMycoPackageCheck } from '@myco/upgrade/checker.js';
import { assetName, resolveTargetTriple } from '@myco/upgrade/release-assets.js';
import { globalFetchDouble } from '../helpers/global-fetch.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let home: string;
let restore: () => void;
let output: string[];
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  network = spyOn(globalThis, 'fetch').mockImplementation(globalFetchDouble(async input => {
    throw new Error(`Unexpected real network call: ${String(input)}`);
  }));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-command-'));
  restore = bindSandboxChildHome(home);
  output = [];
  log = spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  error = spyOn(console, 'error').mockImplementation((...args) => { output.push(args.join(' ')); });
  writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: path.join(home, 'bin', 'myco') });
});
afterEach(() => {
  const calls = network.mock.calls.slice();
  network.mockRestore();
  log.mockRestore(); error.mockRestore(); restore(); process.exitCode = 0;
  fs.rmSync(home, { recursive: true, force: true });
  expect(calls).toEqual([]);
});
const prepareStage = (events: string[]) => async () => {
  events.push('verify');
  const versionDir = path.join(home, 'release');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, 'myco'), '2.0.0-alpha.3');
  fs.writeFileSync(path.join(versionDir, 'myco.exe'), '2.0.0-alpha.3');
  return { version: '2.0.0-alpha.3', versionDir };
};
const place = (events: string[]) => (source: string, dest: string) => {
  events.push('adopt');
  placeExecutable(source, dest);
};
const installedBinary = (version: string) => {
  const binary = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, version);
};
const refs = (version: string) => ({ targetVersion: version, assetName: 'myco-darwin-arm64', assetUrl: 'fixture', sha256sumsUrl: 'sums' });
it('upgrade is exactly the update operation', () => { expect(alias).toBe(run); });
it('verifies and adopts before refreshing agents and reports the recorded channel', async () => {
  installedBinary('2.0.0-alpha.2');
  const events: string[] = [];
  await run([], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => true,
    resolveRefs: async channel => { expect(channel).toBe('alpha'); return refs('2.0.0-alpha.3'); },
    stageBinary: prepareStage(events),
    placeBinary: place(events), probeVersion: file => fs.readFileSync(file, 'utf8'),
    refreshMember: async () => { events.push('refresh'); },
  });
  expect(events).toEqual(['verify', 'adopt', 'refresh']);
  expect(output.join('\n')).toContain('from 2.0.0-alpha.2 to 2.0.0-alpha.3 on channel alpha');
  expect(output.join('\n')).toContain('Agents refreshed: yes.');
  expect(readUpdateNotice(home, '2.0.0-alpha.2')).toContain('myco update');
});
it('refreshes an already current member and surfaces refresh failure with the exact recovery command', async () => {
  let refreshed = 0;
  const deps: UpgradeDeps = { home, currentVersion: '2.0.0-alpha.3', resolveRefs: async () => null, isMemberHome: () => true,
    refreshMember: async () => { refreshed++; throw new Error('timed out'); } };
  await run([], deps);
  expect(refreshed).toBe(1);
  expect(output.join('\n')).toContain('Agents refreshed: no (timed out). Next: myco member provision --refresh');
  expect(process.exitCode).toBe(1);
});
it('check reports only, never stages, adopts or refreshes, and stores a channel-scoped doctor check', async () => {
  const forbidden = async () => { throw new Error('check mutated the install'); };
  await run(['--check'], {
    home, currentVersion: '2.0.0-alpha.2', stageBinary: forbidden, placeBinary: forbidden, refreshMember: forbidden,
    checkFn: async () => ({ id: 'myco', display_name: 'Myco', package_name: '@goondocks/myco', installed: true, installed_version: '2.0.0-alpha.2',
      latest_version: '2.0.0-alpha.3', latest_stable: null, latest_beta: null, update_available: true, revert_available: false }),
  });
  expect(output.join('\n')).toContain('Agents refreshed: no (check only).');
  expect(readUpdateNotice(home, '2.0.0-alpha.2')).toContain('2.0.0-alpha.3');
  expect(readUpdateNotice(home, '2.0.0-alpha.3')).toBeNull();
  expect(readUpdateNotice(home, '2.0.0-alpha.2', Date.now() + 25 * 60 * 60 * 1000)).toBeNull();
});
it('never stages an older channel-selected target', async () => {
  let staged = false;
  await run(['--channel', 'alpha'], {
    home, currentVersion: '2.0.0-alpha.3', isMemberHome: () => false, targetTriple: () => 'darwin-arm64',
    resolveRefs: async () => refs('2.0.0-alpha.1'),
    stageBinary: async () => { staged = true; throw new Error('downgrade reached staging'); },
  });
  expect(staged).toBe(false);
  expect(output.join('\n')).toContain('staying put');
});
it('a runner home delegates all selection flags to the idle-only runner path and never adopts directly', async () => {
  const collected: string[][] = [];
  for (const flags of [[], ['--check'], ['--channel', 'beta', '--target-version', '2.1.0-beta.1']]) {
    await run(flags, { home, currentVersion: '2.0.0-alpha.3',
      runnerRecords: () => [{ version: 1, serverUrl: 'https://fixture.invalid', runnerId: 'runner', name: 'fixture', token: 'fixture' }],
      runnerServiceInstalled: () => true,
      runRunner: async args => { collected.push([...args]); return true; },
      resolveRefs: async () => { throw new Error('runner bypassed its update owner'); },
      placeBinary: async () => { throw new Error('runner adopted outside idle boundary'); },
    });
  }
  expect(collected).toEqual([
    ['update', '--server', 'https://fixture.invalid'],
    ['update', '--server', 'https://fixture.invalid', '--check'],
    ['update', '--server', 'https://fixture.invalid', '--channel', 'beta', '--target-version', '2.1.0-beta.1'],
  ]);
});

it('checks the exact requested version rather than a newer channel release, without mutation', async () => {
  const forbidden = async () => { throw new Error('check mutated the install'); };
  await run(['--check', '--target-version', '2.0.0-alpha.4'], {
    home, currentVersion: '2.0.0-alpha.3', targetTriple: () => 'darwin-arm64',
    fetchReleases: async () => ['2.0.0-alpha.5', '2.0.0-alpha.4'].map(version => ({ tag_name: `myco/v${version}`, prerelease: true, assets: [] })),
    stageBinary: forbidden, placeBinary: forbidden, refreshMember: forbidden,
  });
  expect(output.join('\n')).toContain('from 2.0.0-alpha.3 to 2.0.0-alpha.4 on channel alpha');
  expect(output.join('\n')).not.toContain('2.0.0-alpha.5');
  expect(readUpdateNotice(home, '2.0.0-alpha.3')).toBeNull();
});

for (const mode of ['registered-but-uninstalled member', 'foreground-only runner']) it(`updates the binary on a ${mode} without delegating to a missing service`, async () => {
  installedBinary('2.0.0-alpha.2');
  const events: string[] = [];
  await run([], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => mode.includes('member'),
    runnerRecords: () => [{ version: 1, serverUrl: 'https://fixture.invalid', runnerId: 'runner', name: 'fixture', token: 'fixture' }],
    runRunner: async () => { throw new Error('uninstalled service delegated'); },
    resolveRefs: async () => refs('2.0.0-alpha.3'),
    stageBinary: prepareStage(events),
    placeBinary: place(events), probeVersion: file => fs.readFileSync(file, 'utf8'),
    refreshMember: async () => { events.push('refresh'); },
  });
  expect(events).toEqual(mode.includes('member') ? ['verify', 'adopt', 'refresh'] : ['verify', 'adopt']);
  expect(output.join('\n')).toContain('from 2.0.0-alpha.2 to 2.0.0-alpha.3 on channel alpha');
  expect(output.join('\n')).toContain(mode.includes('member') ? 'Agents refreshed: yes.' : 'Agents refreshed: no (this home is not a member machine).');
});
it('targeted and other-channel checks preserve the recorded-channel doctor notice', async () => {
  const { recordUpdateCheck, CACHE_FILENAME } = await import('@myco/upgrade/check-cache.js');
  recordUpdateCheck(home, 'alpha', '2.0.0-alpha.1', '2.0.0-alpha.3');
  const before = fs.readFileSync(path.join(home, CACHE_FILENAME), 'utf8');
  await run(['--check', '--target-version', '2.0.0-alpha.2'], {
    home, currentVersion: '2.0.0-alpha.1', targetTriple: () => 'darwin-arm64',
    fetchReleases: async () => [{ tag_name: 'myco/v2.0.0-alpha.2', prerelease: true, assets: [] }],
  });
  recordUpdateCheck(home, 'beta', '2.0.0-alpha.1', '2.0.0-beta.1');
  expect(fs.readFileSync(path.join(home, CACHE_FILENAME), 'utf8')).toBe(before);
  expect(readUpdateNotice(home, '2.0.0-alpha.1')).toContain('2.0.0-alpha.3');
});

it('resolves an unmarked home channel from that home and preserves it in override check instructions', async () => {
  const { effectiveUpdateChannel } = await import('@myco/upgrade/check-cache.js');
  const unmarked = path.join(home, 'unmarked'); fs.mkdirSync(unmarked);
  fs.writeFileSync(path.join(unmarked, 'config.yaml'), 'daemon:\n  update_channel: beta\n');
  expect(effectiveUpdateChannel(unmarked)).toBe('beta');
  await run(['--check', '--channel', 'beta', '--target-version', '2.0.0-beta.1'], {
    home, currentVersion: '2.0.0-alpha.1', targetTriple: () => 'darwin-arm64',
    fetchReleases: async () => [{ tag_name: 'myco/v2.0.0-beta.1', prerelease: true, assets: [] }],
  });
  expect(output.join('\n')).toContain('myco update --target-version 2.0.0-beta.1 --channel beta');
});

it('skip-binary on a runner host still blocks agent refresh while an update is pending', async () => {
  const { runnerUpdateStatePath } = await import('@myco/runner/update.js');
  const file = runnerUpdateStatePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0, requests: { fixture: { id: 'fixture', requestedAt: Date.now() } } }));
  let refreshed = false;
  await run(['--skip-binary'], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => true,
    runnerRecords: () => [{ version: 1, serverUrl: 'https://fixture.invalid', runnerId: 'runner', name: 'fixture', token: 'fixture' }],
    runnerServiceInstalled: () => true,
    runRunner: async () => { throw new Error('skip requested a runner update'); },
    refreshMember: async () => { refreshed = true; },
  });
  expect(refreshed).toBe(false);
  expect(output.join('\n')).toContain('binary update skipped (--skip-binary requested)');
  expect(output.join('\n')).toContain('Agents refreshed: no (runner update pending).');
});

it('names retained update directories in the cleanup outcome', async () => {
  const events: string[] = [];
  await run([], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => false,
    resolveRefs: async () => refs('2.0.0-alpha.3'), stageBinary: prepareStage(events),
    placeBinary: place(events), probeVersion: file => fs.readFileSync(file, 'utf8'),
    fs: { ...fs, rmSync: (file, options) => {
      if (String(file).includes('.myco-update-')) throw new Error('cleanup blocked');
      fs.rmSync(file, options);
    } },
  });
  expect(output.join('\n')).toContain('Update files were kept at');
  expect(output.join('\n')).toContain('.myco-update-');
  expect(output.join('\n')).toContain('cleanup blocked');
  expect(output.join('\n')).not.toContain('An earlier version');
  expect(process.exitCode ?? 0).toBe(0);
});

const sourceVersion = '0.0.0-dev+fixture.b1';
const sourceCommit = 'a'.repeat(40);
const sourceArgs = () => ['--source-checkout', home, '--source-commit', sourceCommit];

it('adopts the running source candidate before refreshing member setup', async () => {
  const candidate = path.join(home, 'source-candidate');
  fs.writeFileSync(candidate, sourceVersion);
  const binary = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '2.0.0-alpha.2');
  const events: string[] = [];
  await run(sourceArgs(), {
    home, currentVersion: sourceVersion, sourceBinary: candidate, isMemberHome: () => true,
    probeVersion: file => fs.readFileSync(file, 'utf8'), placeBinary: place(events),
    resolveRefs: async () => { throw new Error('source intent resolved a release'); },
    refreshMember: async () => { events.push('refresh'); },
  });
  expect(events).toEqual(['adopt', 'refresh']);
  expect(readInstallMarker(home, true)).toMatchObject({ source: 'checkout', checkout: home, commit: sourceCommit, version: sourceVersion });
  expect(output.join('\n')).toContain(`from 2.0.0-alpha.2 to ${sourceVersion} (source build)`);
  expect(output.join('\n')).not.toContain('on channel');
  expect(output.join('\n')).toContain('Agents refreshed: yes.');
});

it('routes a source candidate through the installed runner owner', async () => {
  const candidate = path.join(home, 'candidate');
  const { withRunnerUpdateState } = await import('@myco/runner/update.js');
  let queued = false;
  await run(sourceArgs(), {
    home, currentVersion: sourceVersion, sourceBinary: candidate,
    runnerRecords: () => [{ version: 1, serverUrl: 'https://fixture.invalid', runnerId: 'runner', name: 'fixture', token: 'fixture' }],
    runnerServiceInstalled: () => true,
    runRunner: async (args, deps) => {
      expect(args).toEqual(['update', '--server', 'https://fixture.invalid']);
      expect(deps?.sourceArtifact).toEqual({ binaryPath: candidate, version: sourceVersion, checkout: home, commit: sourceCommit });
      queued = true;
      withRunnerUpdateState(home, state => {
        state.requests = { fixture: { id: 'fixture', requestedAt: Date.now() } };
      });
      deps?.stdout?.('Myco: source replacement queued; waiting for the runner to become idle');
      return true;
    },
    placeBinary: () => { throw new Error('source candidate bypassed runner'); },
  });
  expect(queued).toBe(true);
  expect(output.join('\n')).toContain('source replacement queued');
  expect(output.join('\n')).toContain('Agents refreshed: no (runner update pending).');
});

it('refuses incomplete or conflicting source intents before updating', async () => {
  for (const args of [
    ['--source-checkout', home], ['--source-commit', sourceCommit],
    ...[['--check'], ['--skip-binary'], ['--channel', 'alpha'], ['--automatic', 'off'], ['2.0.0-alpha.3'], ['--target-version', '2.0.0-alpha.3']].map(flags => [...sourceArgs(), ...flags]),
  ]) {
    await expect(run(args, { home, currentVersion: sourceVersion })).rejects.toThrow('myco update:');
  }
  for (const [checkout, commit, version] of [['relative', sourceCommit, sourceVersion], [home, 'short', sourceVersion], [home, sourceCommit, '2.0.0']]) {
    await expect(run(['--source-checkout', checkout!, '--source-commit', commit!], { home, currentVersion: version })).rejects.toThrow('Source adoption requires');
  }
});

it('replaces a source build with a release on plain update and announces the switch', async () => {
  const binary = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, sourceVersion);
  publishAdoptedMarker(home, binary, sourceVersion, { kind: 'checkout', checkout: home, commit: sourceCommit });
  const events: string[] = [];
  await run([], {
    home, currentVersion: sourceVersion, isMemberHome: () => false,
    resolveRefs: async () => refs('2.0.0-alpha.3'), stageBinary: prepareStage(events),
    probeVersion: file => fs.readFileSync(file, 'utf8'), placeBinary: place(events),
  });
  expect(events).toEqual(['verify', 'adopt']);
  expect(output.join('\n')).toContain('Replacing this source build with the selected channel release.');
  expect(readInstallMarker(home, true)).toMatchObject({ source: 'curl', version: '2.0.0-alpha.3' });
  expect(readInstallMarker(home, true)).not.toHaveProperty('checkout');
});

it('checks a source build for the release without announcing replacement or changing provenance', async () => {
  const binary = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, sourceVersion);
  publishAdoptedMarker(home, binary, sourceVersion, { kind: 'checkout', checkout: home, commit: sourceCommit });
  const marker = fs.readFileSync(path.join(home, 'install.json'), 'utf8');
  await run(['--check'], { home, currentVersion: sourceVersion,
    checkFn: async (current, channel, installed) => {
      expect(current).toBe(sourceVersion);
      return resolveMycoPackageCheck(current, channel, installed, (async () => Response.json(['1.4.99', '2.0.0-alpha.3'].map(version => ({
        tag_name: `myco/v${version}`, prerelease: version.includes('-'), assets: [{ name: assetName(resolveTargetTriple()) }, { name: 'SHA256SUMS' }],
      })))) as typeof fetch);
    },
  });
  expect(output.join('\n')).toContain('Update available:');
  expect(output.join('\n')).toContain(`from ${sourceVersion} to 2.0.0-alpha.3`);
  expect(output.join('\n')).not.toContain('1.4.99');
  expect(output.join('\n')).not.toContain('Replacing this source build');
  expect(fs.readFileSync(path.join(home, 'install.json'), 'utf8')).toBe(marker);
});

it('keeps adopted source provenance on refresh failure and retries setup without another binary switch', async () => {
  const candidate = path.join(home, 'partial-source');
  fs.writeFileSync(candidate, sourceVersion);
  const events: string[] = [];
  let refreshes = 0;
  const deps: UpgradeDeps = {
    home, currentVersion: sourceVersion, sourceBinary: candidate, isMemberHome: () => true,
    probeVersion: file => fs.readFileSync(file, 'utf8'), placeBinary: place(events),
    refreshMember: async () => { if (++refreshes === 1) throw new Error('setup refused'); },
  };
  await run(sourceArgs(), deps);
  expect(process.exitCode).toBe(1);
  expect(readInstallMarker(home, true)).toMatchObject({ source: 'checkout', version: sourceVersion });
  expect(output.join('\n')).toContain('Agents refreshed: no (setup refused). Next: myco member provision --refresh');
  process.exitCode = 0;
  await run(['--skip-binary'], deps);
  expect(events).toEqual(['adopt']);
  expect(refreshes).toBe(2);
  expect(output.join('\n')).toContain('Agents refreshed: yes.');
});

it('fails an explicit source install refused by a retained runtime command pin without refreshing agents', async () => {
  const candidate = path.join(home, 'source-candidate');
  fs.writeFileSync(candidate, sourceVersion);
  const pin = path.join(home, 'runtime.command');
  fs.writeFileSync(pin, path.join(home, 'another-binary') + '\n', { mode: 0o600 });
  let refreshed = false;
  await run(sourceArgs(), { home, cwd: home, currentVersion: sourceVersion, sourceBinary: candidate,
    isMemberHome: () => true, refreshMember: async () => { refreshed = true; } });
  expect(process.exitCode).toBe(1);
  expect(output.join('\n')).toContain('runtime pin selects another binary');
  expect(refreshed).toBe(false);
  expect(fs.readFileSync(pin, 'utf8')).toBe(path.join(home, 'another-binary') + '\n');
  expect(readInstallMarker(home, true)?.source).toBe('curl');
});

it('prints setup after the first source install into a home without membership', async () => {
  fs.rmSync(path.join(home, 'install.json'));
  const candidate = path.join(home, 'first-source');
  fs.writeFileSync(candidate, sourceVersion);
  await run(sourceArgs(), {
    home, currentVersion: sourceVersion, sourceBinary: candidate, isMemberHome: () => false,
    probeVersion: file => fs.readFileSync(file, 'utf8'), placeBinary: place([]),
  });
  expect(readInstallMarker(home, true)).toMatchObject({ source: 'checkout', version: sourceVersion });
  expect(output.join('\n')).toContain(`Installed ${sourceVersion} (source build)`);
  expect(output.join('\n')).not.toContain('from ');
  expect(output.join('\n')).toContain('Next: myco setup');
});


it('keeps a source build when stable has no eligible 2.x release and explains channel selection', async () => {
  const binary = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, sourceVersion);
  writeInstallMarker(home, { channel: 'stable', source: 'curl', bin: binary });
  publishAdoptedMarker(home, binary, sourceVersion, { kind: 'checkout', checkout: home, commit: sourceCommit });
  const before = fs.readFileSync(path.join(home, 'install.json'));
  await run([], {
    home, currentVersion: sourceVersion, isMemberHome: () => false,
    fetch: (async () => Response.json([{ tag_name: 'myco/v1.4.99', prerelease: false, assets: [] },
      { tag_name: 'myco/v2.0.0-alpha.3', prerelease: true, assets: [{ name: assetName(resolveTargetTriple()) }, { name: 'SHA256SUMS' }] }])) as typeof fetch,
    probeVersion: file => fs.readFileSync(file, 'utf8'),
    stageBinary: async () => { throw new Error('ineligible release reached staging'); },
  });
  expect(output.join('\n')).toContain(`kept source build ${sourceVersion}`);
  expect(output.join('\n')).toContain('myco update --channel alpha');
  expect(output.join('\n')).not.toContain('Replacing this source build');
  expect(fs.readFileSync(path.join(home, 'install.json'))).toEqual(before);
  expect(fs.readFileSync(binary, 'utf8')).toBe(sourceVersion);
});

it('does not announce source replacement when preparing a release fails', async () => {
  const binary = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, sourceVersion);
  publishAdoptedMarker(home, binary, sourceVersion, { kind: 'checkout', checkout: home, commit: sourceCommit });
  await run([], { home, currentVersion: sourceVersion, isMemberHome: () => false,
    resolveRefs: async () => refs('2.0.0-alpha.3'), probeVersion: file => fs.readFileSync(file, 'utf8'),
    stageBinary: async () => ({ error: 'download failed' }),
  });
  expect(output.join('\n')).toContain('download failed');
  expect(output.join('\n')).not.toContain('Replacing this source build');
  expect(process.exitCode).toBe(1);
});

for (const args of [[], ['--target-version', '2.0.0-alpha.3'], ['--check'], ['--check', '--target-version', '2.0.0-alpha.3']]) {
  it(`uses the injected fetch for release selection: ${args.join(' ') || 'channel update'}`, async () => {
    let requests = 0;
    installedBinary('2.0.0-alpha.2');
    await run(args, {
      home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => false,
      fetch: async () => {
        requests++;
        return Response.json([{ tag_name: 'myco/v2.0.0-alpha.3', prerelease: true, assets: [
          { name: assetName(resolveTargetTriple()), browser_download_url: 'fixture' },
          { name: 'SHA256SUMS', browser_download_url: 'sums' },
        ] }]);
      },
      stageBinary: prepareStage([]), placeBinary: place([]), probeVersion: file => fs.readFileSync(file, 'utf8'),
    });
    expect(requests).toBe(1);
    expect(process.exitCode ?? 0).toBe(0);
    expect(output.join('\n')).toContain('from 2.0.0-alpha.2 to 2.0.0-alpha.3');
  });
}

it('uses the injected release list for channel selection', async () => {
  let requests = 0;
  await run([], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => false,
    fetchReleases: async () => { requests++; return []; },
  });
  expect(requests).toBe(1);
  expect(process.exitCode ?? 0).toBe(0);
  expect(output.join('\n')).toContain('no newer eligible release');
});
