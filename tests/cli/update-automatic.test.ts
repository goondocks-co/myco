import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, UPDATE_HELP, type UpgradeDeps } from '@myco/cli/update.js';
import { automaticUpdatesEnabled, readAutomaticUpdatePreference } from '@myco/install/marker-reader.js';
import { readInstallMarker, writeInstallMarker } from '@myco/install/managed-binary.js';
import { attemptAutomaticUpdate, readAutomaticUpdate } from '@myco/member/automatic-update-state.js';
import { checkAutomaticUpdate } from '@myco/cli/doctor-member.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let root: string;
let home: string;
let restore: () => void;
let output: string[];
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
const markerFile = () => path.join(home, 'install.json');
const preferenceFile = () => path.join(home, 'install-update.json');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-automatic-'));
  restore = bindSandboxChildHome(root);
  home = path.join(root, '.myco');
  writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: path.join(home, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco') });
  output = [];
  log = spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  error = spyOn(console, 'error').mockImplementation((...args) => { output.push(args.join(' ')); });
});
afterEach(() => {
  log.mockRestore(); error.mockRestore(); restore(); process.exitCode = 0;
  fs.rmSync(root, { recursive: true, force: true });
});
const forbidden = () => { throw new Error('setting command performed update work'); };
const deps = (): UpgradeDeps => ({
  home, cwd: root, currentVersion: '2.0.0-alpha.3', runnerRecords: forbidden,
  resolveRefs: forbidden, stageBinary: forbidden, checkFn: forbidden, refreshMember: forbidden,
});

it('persists off and on beside the channel without running any update or refresh', async () => {
  const before = readInstallMarker(home, true)!;
  for (const automatic of ['off', 'on']) {
    await run(['--automatic', automatic], deps());
    expect(readInstallMarker(home, true)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(preferenceFile(), 'utf8'))).toEqual({ automaticUpdates: automatic === 'on' });
    expect(readAutomaticUpdatePreference(home)).toEqual({ enabled: automatic === 'on' });
    expect(output.at(-1)).toBe(`Automatic updates are turned ${automatic}.`);
  }
  expect(UPDATE_HELP).toContain('--automatic <off|on>');
});

it('keeps a saved preference when another marker publication updates the installation', async () => {
  await run(['--automatic', 'off'], deps());
  const snapshot = readInstallMarker(home, true)!;
  writeInstallMarker(home, { ...snapshot, channel: 'beta' });
  fs.writeFileSync(markerFile(), '{broken');
  writeInstallMarker(home, { ...snapshot, channel: 'beta' });
  expect(readAutomaticUpdatePreference(home)).toEqual({ enabled: false });
  expect(readInstallMarker(home, true)?.channel).toBe('beta');
});

for (const flags of [
  ['--automatic', 'maybe'], ['--automatic'],
  ['--automatic', 'off', '2.0.0-alpha.1'], ['--automatic', 'on', '--target-version', '2.0.0-alpha.1'],
  ...['--check', '--skip-binary', '--claim', '--now'].map(flag => ['--automatic', 'off', flag]),
  ['--automatic', 'on', '--channel', 'beta'],
]) it(`rejects ${flags.join(' ')} before writing`, async () => {
  const before = fs.readFileSync(markerFile(), 'utf8');
  const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
  const stderr = spyOn(process.stderr, 'write').mockImplementation(text => { output.push(String(text)); return true; });
  try { await expect(run(flags, deps())).rejects.toThrow(/exit [12]/); }
  finally { exit.mockRestore(); stderr.mockRestore(); }
  expect(output.join('\n')).toMatch(/--automatic (must be|requires a value|cannot be combined)/);
  expect(fs.readFileSync(markerFile(), 'utf8')).toBe(before);
  expect(fs.readdirSync(home)).toEqual(['install.json']);
});

it('defaults missing and corrupt preferences to on and reports unreadable preferences in doctor', () => {
  expect(readAutomaticUpdatePreference(home)).toEqual({ enabled: true });
  fs.rmSync(markerFile());
  expect(automaticUpdatesEnabled(home)).toBe(true);
  expect(readAutomaticUpdatePreference(home)).toEqual({ enabled: true });
  fs.writeFileSync(preferenceFile(), '{}');
  expect(readAutomaticUpdatePreference(home)).toEqual({ enabled: true });
  for (const text of ['{broken', 'null', JSON.stringify({ automaticUpdates: 'off' })]) {
    fs.writeFileSync(preferenceFile(), text);
    expect(readAutomaticUpdatePreference(home)).toMatchObject({ enabled: true, error: expect.any(String) });
    expect(checkAutomaticUpdate(home)).toMatchObject({ status: 'warn', detail: expect.stringContaining('on (default); could not read') });
  }
  fs.rmSync(preferenceFile());
  fs.mkdirSync(preferenceFile());
  expect(readAutomaticUpdatePreference(home)).toMatchObject({ enabled: true, error: expect.any(String) });
  expect(checkAutomaticUpdate(home).detail).toContain('on (default); could not read');
});

it('saves the preference in an unmarked installation without inventing a channel or binary destination', async () => {
  fs.rmSync(markerFile());
  await run(['--automatic', 'off'], deps());
  expect(readInstallMarker(home, true)).toBeNull();
  expect(automaticUpdatesEnabled(home)).toBe(false);
});

it('turning on makes the very next pass due even after a fresh skipped attempt', async () => {
  const now = () => 1_000_000;
  await run(['--automatic', 'off'], deps());
  await attemptAutomaticUpdate(home, now, async () => ({ kind: 'skipped', reason: 'automatic updates are turned off' }));
  expect(readAutomaticUpdate(home)?.lastAttemptAt).toBe(now());
  await run(['--automatic', 'on'], deps());
  let attempts = 0;
  const outcome = await attemptAutomaticUpdate(home, now, async () => {
    attempts++;
    return { kind: 'already-current', version: '2.0.0-alpha.3', reason: 'current' };
  });
  expect(attempts).toBe(1);
  expect(outcome?.lastOutcome.kind).toBe('already-current');
});

for (const automatic of [true, false]) for (const target of ['2.0.0-alpha.2', '2.0.0-alpha.3', '2.0.0-alpha.4']) {
  it(`prints a step-back hint only for an older adopted version with updates on: ${target}, ${automatic}`, async () => {
    await run(['--automatic', automatic ? 'on' : 'off'], deps());
    const binary = readInstallMarker(home, true)!.bin;
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '2.0.0-alpha.3');
    const stage = path.join(root, 'stage'); fs.mkdirSync(stage);
    for (const file of ['myco', 'myco.exe']) fs.writeFileSync(path.join(stage, file), target);
    await run([target], {
      home, cwd: root, currentVersion: '2.0.0-alpha.1', mycoBinary: binary, isMemberHome: () => false,
      targetTriple: () => 'darwin-arm64',
      fetchReleases: async () => [{ tag_name: `myco/v${target}`, prerelease: true, assets: [] }],
      stageBinary: async () => ({ version: target, versionDir: stage }),
      placeBinary: (source, dest) => { fs.copyFileSync(source, dest); },
      probeVersion: file => fs.readFileSync(file, 'utf8'),
    });
    expect(output.join('\n').includes('Automatic updates will move this machine forward again')).toBe(automatic && target.endsWith('.2'));
    expect(fs.readFileSync(binary, 'utf8')).toBe(target);
    if (automatic && target.endsWith('.2')) expect(output.join('\n')).toContain('myco update --automatic off` to stay on this version');
  });
}

it('does not print a step-back hint when an older requested version fails to adopt', async () => {
  await run(['2.0.0-alpha.2'], {
    home, cwd: root, currentVersion: '2.0.0-alpha.3', isMemberHome: () => false,
    targetTriple: () => 'darwin-arm64',
    fetchReleases: async () => [{ tag_name: 'myco/v2.0.0-alpha.2', prerelease: true, assets: [] }],
    stageBinary: async () => ({ error: 'fixture could not be verified' }),
  });
  expect(process.exitCode).toBe(1);
  expect(output.join('\n')).toContain('update failed');
  expect(output.join('\n')).not.toContain('Automatic updates will move this machine forward again');
});
