import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHelperVerb, AUTOMATIC_UPDATE_MIN_BUDGET_MS, type HelperVerbDeps } from '@myco/cli/member-helper.js';
import { readAutomaticUpdate, AUTOMATIC_UPDATE_INTERVAL_MS, attemptAutomaticUpdate } from '@myco/member/automatic-update-state.js';
import { updateBinary, binaryUpdatePath, type BinaryUpdateDeps, type BinaryUpdateOutcome } from '@myco/upgrade/guarded-binary.js';
import { hasAdoptFailed } from '@myco/upgrade/adopt-failed.js';
import { updateBudget } from '@myco/upgrade/update-budget.js';
import { checkAutomaticUpdate } from '@myco/cli/doctor-member.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { provisionGlobally, runStatus } from '@myco/cli/member.js';
import { readProvisionRecord, recordProvision } from '@myco/member/provision-record.js';
import { writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { writeInstallMarker, managedBinaryPath } from '@myco/install/managed-binary.js';
import { placeExecutable } from '@myco/install/place-binary.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { claimSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/member/subsystem-claim.js';
import { helperPaths, helperLogPath, kickHelper } from '@myco/member/helper.js';
import { resolveBinary } from '@myco/runtime/binary-resolution.js';
import { getPluginVersion, setPluginVersion } from '@myco/version.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

const SERVER = 'https://fixture.invalid';
const FROM = '2.0.0-alpha.2';
const TO = '2.0.0-alpha.3';
let root: string;
let home: string;
let live: string;
let clock: number;
let restore: () => void;
const originalVersion = getPluginVersion();
const now = () => clock;
const stateFile = () => path.join(home, 'member', 'keep-current.json');
const args = () => ['--project', 'proj_fixture', '--server', SERVER, '--home', home];
const pass = (deps: HelperVerbDeps = {}) => runHelperVerb(args(), {
  now, lingerMs: 0, keepCurrent: () => null, pass: async () => {}, ...deps,
});
let binaryDeps: BinaryUpdateDeps;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-daily-update-'));
  restore = bindSandboxChildHome(root);
  home = path.join(root, '.myco');
  live = path.join(home, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, FROM, { mode: 0o755 });
  writeInstallMarker(home, { bin: live, source: 'curl', channel: 'alpha' });
  clock = 1_000_000;
  writeRegistryEntry({ version: 2, projectId: 'proj_fixture', root, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  binaryDeps = {
    home, cwd: root, currentVersion: FROM, mycoBinary: live,
    resolveRefs: async () => null,
    probeVersion: file => fs.readFileSync(file, 'utf8'),
    stageBinary: async () => { throw new Error('no download allowed'); },
  };
});
afterEach(() => { setPluginVersion(originalVersion); restore(); fs.rmSync(root, { recursive: true, force: true }); });

it('attempts once per day across helper passes and treats corrupt state as due', async () => {
  let attempts = 0;
  const update: typeof updateBinary = async (caller, options, deps) => {
    expect(caller).toBe('automatic');
    expect(options).toEqual({});
    expect(deps?.home).toBe(home);
    expect(deps?.deadline).toBe(clock + 120_000);
    attempts++;
    return { kind: 'already-current', version: FROM, reason: 'no newer release' };
  };
  await pass({ updateBinary: update });
  clock += AUTOMATIC_UPDATE_INTERVAL_MS - 1;
  await pass({ updateBinary: update });
  expect(attempts).toBe(1);
  clock += 2;
  await pass({ updateBinary: update });
  expect(attempts).toBe(2);
  fs.writeFileSync(stateFile(), '{broken');
  await pass({ updateBinary: update });
  expect(attempts).toBe(3);
  expect(fs.readFileSync(helperLogPath(home), 'utf8').match(/automatic update:/g)).toHaveLength(3);
  fs.writeFileSync(stateFile(), JSON.stringify({ lastAttemptAt: clock, lastOutcome: { kind: 'adopted' } }));
  await pass({ updateBinary: update });
  expect(attempts).toBe(4);
  fs.writeFileSync(stateFile(), JSON.stringify({ lastAttemptAt: 1e99, lastOutcome: { kind: 'failed', reason: 'damaged timestamp' } }));
  expect(checkAutomaticUpdate(home).status).toBe('info');
  await pass({ updateBinary: update });
  expect(attempts).toBe(5);
});

it('serializes the due check across overlapping project helpers', async () => {
  let release!: () => void;
  const first = attemptAutomaticUpdate(home, now, async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { kind: 'already-current', version: FROM, reason: 'current' };
  });
  const second = await attemptAutomaticUpdate(home, now, async () => { throw new Error('second attempt'); });
  expect(second).toBeNull();
  release();
  expect((await first)?.lastOutcome.kind).toBe('already-current');
});

it('updates before repair acquires its non-reentrant lease', async () => {
  const order: string[] = [];
  await pass({
    binaryUpdateDeps: binaryDeps,
    updateBinary: async (...args) => { order.push('binary'); return updateBinary(...args); },
    keepCurrent: () => {
      const held = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK));
      expect(held.acquired).toBe(true);
      try { order.push('repair'); return null; } finally { if (held.acquired) held.lock.release(); }
    },
    pass: async () => { order.push('delivery'); },
  });
  expect(order).toEqual(['binary', 'repair', 'delivery']);
  expect(readAutomaticUpdate(home)?.lastOutcome.kind).toBe('already-current');
  expect(readAutomaticUpdate(home)?.lastOutcome.reason).not.toContain('running');
});

it.each<BinaryUpdateOutcome>([
  { kind: 'skipped', reason: 'runtime pin selects another binary' },
  { kind: 'failed', reason: 'release service unavailable' },
  { kind: 'failed', reason: 'release service unavailable\ntry later' },
  { kind: 'rolled-back', version: FROM, reason: 'installed version did not match' },
])('records and displays $kind with its reason in doctor and status', async outcome => {
  let attempts = 0;
  await pass({ updateBinary: async () => { attempts++; return outcome; } });
  await pass({ updateBinary: async () => { attempts++; throw new Error('must not retry'); } });
  expect(attempts).toBe(1);
  expect(readAutomaticUpdate(home)).toEqual({ lastAttemptAt: clock, lastOutcome: outcome });
  const check = checkAutomaticUpdate(home);
  expect(check.detail).toContain(new Date(clock).toISOString());
  expect(check.detail).toContain('reason' in outcome ? outcome.reason.replace(/[\r\n]+/g, ' ') : '');
  expect(check.status).toBe(outcome.kind === 'skipped' ? 'ok' : 'warn');
  expect((await homeReport(home, {
    cwd: root, now, fetch: async () => Response.json({}), worker: { platform: 'linux', runner: recordingPlatform().runner, ownDeploymentUrls: async () => [] },
  })).filter(row => row.name === 'Automatic update')).toEqual([check]);
  const lines: string[] = [];
  runStatus(['--all'], { mycoHome: home, cwd: root, now, worker: { platform: 'linux', runner: recordingPlatform().runner }, stdout: line => lines.push(line), stderr: () => {} });
  expect(lines.join('\n')).toContain(check.detail);
  expect(fs.readFileSync(helperLogPath(home), 'utf8')).toContain('reason' in outcome ? outcome.reason.replace(/[\r\n]+/g, ' ') : '');
});

it('release resolution failures count as attempts and do not block capture delivery', async () => {
  let resolutions = 0;
  let delivered = 0;
  const deps = { ...binaryDeps, resolveRefs: async () => { resolutions++; throw new Error('offline fixture'); } };
  await pass({ binaryUpdateDeps: deps, pass: async () => { delivered++; } });
  await pass({ binaryUpdateDeps: deps, pass: async () => { delivered++; } });
  expect(resolutions).toBe(1);
  expect(delivered).toBe(2);
  expect(checkAutomaticUpdate(home)).toMatchObject({ status: 'warn', detail: expect.stringContaining('offline fixture') });
});

it('a non-default home records one skip a day and never stages', async () => {
  home = path.join(root, 'custom-home');
  writeRegistryEntry({ version: 2, projectId: 'proj_fixture', root, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  let staged = 0;
  let resolved = 0;
  const deps = {
    ...binaryDeps, resolveRefs: async () => { resolved++; return null; },
    stageBinary: async () => { staged++; return { error: 'unexpected' }; },
  };
  await pass({ binaryUpdateDeps: deps });
  await pass({ binaryUpdateDeps: deps });
  const first = readAutomaticUpdate(home);
  expect(first?.lastOutcome).toEqual({ kind: 'skipped', reason: 'this is not the default Myco home' });
  expect(fs.readFileSync(helperLogPath(home), 'utf8').match(/automatic update:/g)).toHaveLength(1);
  clock += AUTOMATIC_UPDATE_INTERVAL_MS + 1;
  await pass({ binaryUpdateDeps: deps });
  expect(readAutomaticUpdate(home)?.lastAttemptAt).toBe(clock);
  expect(staged).toBe(0);
  expect(resolved).toBe(0);
  expect(fs.readFileSync(live, 'utf8')).toBe(FROM);
});

it('defers a check without recording or starting when too little budget remains', async () => {
  let attempts = 0;
  await pass({
    deadlineMs: AUTOMATIC_UPDATE_MIN_BUDGET_MS - 1,
    updateBinary: async () => { attempts++; throw new Error('must defer'); },
  });
  expect(attempts).toBe(0);
  expect(readAutomaticUpdate(home)).toBeNull();
});

it('does not stage when release discovery exhausts the shared deadline', async () => {
  let staged = 0;
  await pass({ binaryUpdateDeps: {
    ...binaryDeps,
    resolveRefs: async () => {
      clock += 120_001;
      return { targetVersion: TO, assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' };
    },
    stageBinary: async () => { staged++; return { error: 'unexpected' }; },
  } });
  expect(staged).toBe(0);
  expect(checkAutomaticUpdate(home)).toMatchObject({ status: 'warn', detail: expect.stringContaining('ran out of time') });
  expect(fs.readFileSync(live, 'utf8')).toBe(FROM);
});

it('passes the remaining deadline to actual network requests', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    return new Response('fixture');
  });
  try {
    const budget = updateBudget({ deadline: clock + 2000, now });
    await budget.fetch('https://fixture.invalid');
    clock += 2001;
    expect(() => budget.fetch('https://fixture.invalid')).toThrow('ran out of time');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); }
});

it.each([false, true])('an adopted version refreshes in the same pass; peer claim = %p', async peer => {
  setPluginVersion(FROM);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const config = path.join(root, '.codex', 'config.toml');
  const before = fs.readFileSync(config, 'utf8');
  if (peer) claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, path.join(root, 'peer'));
  else claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, home);
  const install = spyOn((await import('@myco/symbionts/installer.js')).SymbiontInstaller.prototype, 'install');
  const stage = path.join(root, 'release');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'myco'), TO);
  fs.writeFileSync(path.join(stage, 'myco.exe'), TO);
  let refreshes = 0;
  let delivered = false;
  try {
    await pass({
      binaryUpdateDeps: {
        ...binaryDeps, resolveRefs: async () => ({ targetVersion: TO, assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' }),
        stageBinary: async () => ({ version: TO, versionDir: stage }),
        placeBinary: (source, dest, options) => placeExecutable(source, dest, { ...options, ready: () => ({ runs: true }) }),
      },
      refreshMember: async (binary, selected, timeout) => {
        expect(binary).toBe(live);
        expect(selected).toBe(home);
        expect(timeout).toBe(120_000);
        expect(fs.readFileSync(binary, 'utf8')).toBe(TO);
        expect(readAutomaticUpdate(home)?.lastOutcome).toEqual({ kind: 'adopted', version: TO });
        refreshes++;
        setPluginVersion(TO);
        keepCurrent(home, { binaryFound: () => true });
        setPluginVersion(FROM);
      },
      keepCurrent: () => { throw new Error('old helper must not provision with old manifests'); },
      pass: async () => { delivered = true; },
    });
    expect(readAutomaticUpdate(home)?.lastOutcome).toEqual({ kind: 'adopted', version: TO });
    expect(refreshes).toBe(1);
    expect(delivered).toBe(true);
    expect(install.mock.calls.length).toBe(peer ? 0 : 1);
    expect(readProvisionRecord(home)?.version).toBe(peer ? FROM : TO);
    if (peer) expect(fs.readFileSync(config, 'utf8')).toBe(before);
  } finally { install.mockRestore(); }
});

it('version-only drift reprovisions even when hooks and tools are already current', async () => {
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  recordProvision(home, { version: FROM, serverUrl: SERVER, agents: ['codex'] });
  const install = spyOn((await import('@myco/symbionts/installer.js')).SymbiontInstaller.prototype, 'install');
  try {
    keepCurrent(home, { binaryFound: () => true });
    expect(install).toHaveBeenCalledTimes(1);
    expect(readProvisionRecord(home)?.version).toBe(getPluginVersion());
  } finally { install.mockRestore(); }
});

it('successors and kicks from a compiled helper use the live path after rename-aside', async () => {
  const previous = path.join(path.dirname(live), 'myco.prev.exe');
  expect(resolveBinary('member-helper', { kind: 'machine' }, { mycoHome: home, platform: 'win32', execPath: previous, argv1: 'B:/~BUN/root/myco.exe' })).toMatchObject({ path: live, args: [] });
  expect(resolveBinary('member-helper', { kind: 'machine' }, { mycoHome: home, platform: 'win32', execPath: previous.toUpperCase(), argv1: 'B:/~BUN/root/myco.exe' }).path).toBe(live);
  const otherBuild = path.join(root, 'worktree', 'myco');
  expect(resolveBinary('member-helper', { kind: 'machine' }, { mycoHome: home, execPath: otherBuild, argv1: '/$bunfs/main' }).path).toBe(otherBuild);
  const oldArgv = process.argv[1];
  const oldExec = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  Object.defineProperty(process, 'execPath', { ...oldExec, value: live });
  process.argv[1] = '/$bunfs/main';
  const starts: string[] = [];
  try {
    clock = 100;
    await pass({
      deadlineMs: 120_000,
      updateBinary: async () => ({ kind: 'already-current', version: TO, reason: 'current' }),
      pass: async () => {
        fs.writeFileSync(helperPaths('proj_fixture', home, SERVER).dirty, '');
        clock += 120_000;
      },
      spawn: (binary) => { starts.push(binary); return { started: false }; },
    });
    expect(starts).toEqual([live]);
    kickHelper({ projectId: 'proj_other', serverUrl: SERVER, mycoHome: home, now, spawn: binary => { starts.push(binary); return { started: false }; } });
    expect(starts).toEqual([live, live]);
  } finally { process.argv[1] = oldArgv; Object.defineProperty(process, 'execPath', oldExec); }
});

it.each([FROM, TO, null])('shows a failed same-pass agent refresh with provision version %p', async version => {
  if (version !== null) recordProvision(home, { version, serverUrl: SERVER, agents: ['codex'] });
  await pass({
    updateBinary: async () => ({ kind: 'adopted', version: TO }),
    refreshMember: async () => { throw new Error('configuration fixture is unwritable'); },
    keepCurrent: () => { throw new Error('old build must not repair'); },
  });
  expect(readAutomaticUpdate(home)?.lastOutcome).toEqual({
    kind: 'adopted', version: TO, reason: 'agents could not be refreshed: configuration fixture is unwritable',
  });
  expect(checkAutomaticUpdate(home)).toMatchObject({
    status: 'warn', detail: expect.stringContaining('configuration fixture is unwritable'),
  });
});

it('does not start a download with too little time after release discovery', async () => {
  let staged = 0;
  await pass({ binaryUpdateDeps: {
    ...binaryDeps,
    resolveRefs: async () => {
      clock += 110_000;
      return { targetVersion: TO, assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' };
    },
    stageBinary: async () => { staged++; return { error: 'unexpected' }; },
  } });
  expect(staged).toBe(0);
  expect(readAutomaticUpdate(home)?.lastOutcome).toEqual({ kind: 'skipped', reason: 'not enough time remains to download an update' });
});

it('restores an expired post-check without marking the release as broken', async () => {
  const stage = path.join(root, 'deadline-release');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'myco'), TO);
  fs.writeFileSync(path.join(stage, 'myco.exe'), TO);
  await pass({ binaryUpdateDeps: {
    ...binaryDeps,
    resolveRefs: async () => ({ targetVersion: TO, assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' }),
    stageBinary: async () => ({ version: TO, versionDir: stage }),
    placeBinary: (source, dest, options) => placeExecutable(source, dest, { ...options, ready: () => ({ runs: true }) }),
    probeVersion: file => {
      const version = fs.readFileSync(file, 'utf8');
      if (file === live && version === TO) clock += 120_001;
      return version;
    },
  } });
  expect(readAutomaticUpdate(home)?.lastOutcome).toMatchObject({
    kind: 'failed', reason: expect.stringContaining('ran out of time'),
  });
  expect(fs.readFileSync(live, 'utf8')).toBe(FROM);
  expect(hasAdoptFailed(home, process.platform, TO)).toBe(false);
});

it('keeps the Windows local app-data destination when the install marker is absent', () => {
  const unmarked = path.join(root, 'unmarked');
  expect(binaryUpdatePath(unmarked, { platform: 'win32' })).toBe(managedBinaryPath(unmarked, 'win32', process.env.LOCALAPPDATA));
});

it.each([true, false])('an older helper preserves another helper’s adopted setup; refresh complete = %p', async complete => {
  setPluginVersion(TO);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  fs.writeFileSync(live, TO, { mode: 0o755 });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const config = path.join(root, '.codex', 'config.toml');
  const before = fs.readFileSync(config, 'utf8');
  if (!complete) {
    recordProvision(home, { version: FROM, serverUrl: SERVER, agents: ['codex'] });
    await attemptAutomaticUpdate(home, now, async () => ({ kind: 'adopted', version: TO, reason: 'one agent still needs repair' }));
  }
  setPluginVersion(FROM);
  const install = spyOn((await import('@myco/symbionts/installer.js')).SymbiontInstaller.prototype, 'install');
  let delivered = false;
  try {
    await pass({
      binaryUpdateDeps: binaryDeps,
      keepCurrent: selected => keepCurrent(selected, { binaryFound: () => true }),
      pass: async () => { delivered = true; },
    });
    expect(delivered).toBe(true);
    expect(install).not.toHaveBeenCalled();
    expect(readProvisionRecord(home)?.version).toBe(complete ? TO : FROM);
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
  } finally { install.mockRestore(); }
});

it('a development build still refreshes setup recorded by a release', async () => {
  setPluginVersion(TO);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  setPluginVersion('0.0.0-dev+fixture');
  const install = spyOn((await import('@myco/symbionts/installer.js')).SymbiontInstaller.prototype, 'install');
  try {
    keepCurrent(home, { binaryFound: () => true });
    expect(install).toHaveBeenCalledTimes(1);
    expect(readProvisionRecord(home)?.version).toBe('0.0.0-dev+fixture');
  } finally { install.mockRestore(); }
});
