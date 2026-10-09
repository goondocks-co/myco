import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type UpgradeDeps } from '@myco/cli/update.js';
import { run as alias } from '@myco/cli/upgrade.js';
import { writeInstallMarker } from '@myco/install/managed-binary.js';
import { readUpdateNotice } from '@myco/upgrade/check-cache.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let home: string;
let restore: () => void;
let output: string[];
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-command-'));
  restore = bindSandboxChildHome(home);
  output = [];
  log = spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  error = spyOn(console, 'error').mockImplementation((...args) => { output.push(args.join(' ')); });
  writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: path.join(home, 'bin', 'myco') });
});
afterEach(() => { log.mockRestore(); error.mockRestore(); restore(); process.exitCode = 0; fs.rmSync(home, { recursive: true, force: true }); });
const refs = (version: string) => ({ targetVersion: version, assetName: 'myco-darwin-arm64', assetUrl: 'fixture', sha256sumsUrl: 'sums' });
it('upgrade is exactly the update operation', () => { expect(alias).toBe(run); });
it('verifies and adopts before refreshing agents and reports the recorded channel', async () => {
  const events: string[] = [];
  await run([], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => true,
    resolveRefs: async channel => { expect(channel).toBe('alpha'); return refs('2.0.0-alpha.3'); },
    stageBinary: async () => { events.push('verify'); return { version: '2.0.0-alpha.3', versionDir: home }; },
    adoptStaged: async () => { events.push('adopt'); },
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
    home, currentVersion: '2.0.0-alpha.2', stageBinary: forbidden, adoptStaged: forbidden, refreshMember: forbidden,
    checkFn: async () => ({ id: 'myco', display_name: 'Myco', package_name: '@goondocks/myco', installed: true, installed_version: '2.0.0-alpha.2',
      latest_version: '2.0.0-alpha.3', latest_stable: null, latest_beta: null, update_available: true, revert_available: false }),
  });
  expect(output.join('\n')).toContain('Agents refreshed: no (check only).');
  expect(readUpdateNotice(home, '2.0.0-alpha.2')).toContain('2.0.0-alpha.3');
  expect(readUpdateNotice(home, '2.0.0-alpha.3')).toBeNull();
  expect(readUpdateNotice(home, '2.0.0-alpha.2', Date.now() + 25 * 60 * 60 * 1000)).toBeNull();
});
it('never stages an explicit older target, including a channel override', async () => {
  let staged = false;
  await run(['--target-version', '2.0.0-alpha.1', '--channel', 'alpha'], {
    home, currentVersion: '2.0.0-alpha.3', isMemberHome: () => false, targetTriple: () => 'darwin-arm64',
    fetchReleases: async () => [{ tag_name: 'myco/v2.0.0-alpha.1', prerelease: true, assets: [] }],
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
      adoptStaged: async () => { throw new Error('runner adopted outside idle boundary'); },
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
    stageBinary: forbidden, adoptStaged: forbidden, refreshMember: forbidden,
  });
  expect(output.join('\n')).toContain('from 2.0.0-alpha.3 to 2.0.0-alpha.4 on channel alpha');
  expect(output.join('\n')).not.toContain('2.0.0-alpha.5');
  expect(readUpdateNotice(home, '2.0.0-alpha.3')).toBeNull();
});

for (const mode of ['registered-but-uninstalled member', 'foreground-only runner']) it(`updates the binary on a ${mode} without delegating to a missing service`, async () => {
  const events: string[] = [];
  await run([], {
    home, currentVersion: '2.0.0-alpha.2', isMemberHome: () => mode.includes('member'),
    runnerRecords: () => [{ version: 1, serverUrl: 'https://fixture.invalid', runnerId: 'runner', name: 'fixture', token: 'fixture' }],
    runRunner: async () => { throw new Error('uninstalled service delegated'); },
    resolveRefs: async () => refs('2.0.0-alpha.3'),
    stageBinary: async () => { events.push('verify'); return { version: '2.0.0-alpha.3', versionDir: home }; },
    adoptStaged: async () => { events.push('adopt'); },
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
