import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHelperVerb, AUTOMATIC_UPDATE_MIN_BUDGET_MS, AUTOMATIC_REFRESH_MIN_BUDGET_MS, type HelperVerbDeps } from '@myco/cli/member-helper.js';
import { readAutomaticUpdate, AUTOMATIC_UPDATE_INTERVAL_MS, AUTOMATIC_UPDATE_CLOCK_SKEW_MS, automaticUpdateWords, attemptAutomaticUpdate } from '@myco/member/automatic-update-state.js';
import { updateBinary, binaryUpdatePath, type BinaryUpdateDeps, type BinaryUpdateOutcome } from '@myco/upgrade/guarded-binary.js';
import { hasAdoptFailed } from '@myco/upgrade/adopt-failed.js';
import { updateBudget } from '@myco/upgrade/update-budget.js';
import { checkAutomaticUpdate } from '@myco/cli/doctor-member.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { provisionGlobally, provisionAgents, runProvision, runStatus } from '@myco/cli/member.js';
import { readProvisionRecord, recordProvision } from '@myco/member/provision-record.js';
import { writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { writeAutomaticUpdatePreference, writeInstallMarker, managedBinaryPath } from '@myco/install/managed-binary.js';
import { placeExecutable } from '@myco/install/place-binary.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { claimSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/member/subsystem-claim.js';
import { helperPaths, helperLogPath, kickHelper, runHelper } from '@myco/member/helper.js';
import { resolveBinary } from '@myco/runtime/binary-resolution.js';
import * as binaryVersion from '@myco/runtime/binary-version.js';
import * as binaryResolution from '@myco/runtime/binary-resolution.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { kickWaitingProjects } from '@myco/member/sweep.js';
import { MemberSpool } from '@myco/member/spool.js';
import { promptEvent } from '@myco/member/envelope.js';
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { main as sessionStart } from '@myco/hooks/session-start.js';
import * as hookResponse from '@myco/hooks/response.js';
import { _resetManifestCache } from '@myco/hooks/normalize.js';
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
function compiledProcess(executable: string) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  const argv1 = process.argv[1];
  Object.defineProperty(process, 'execPath', { ...descriptor, value: executable });
  process.argv[1] = '/$bunfs/main';
  const matches = spyOn(binaryResolution, 'isRunningExecutable').mockImplementation(binaryResolution.captureExecutableIdentity(executable));
  return () => { matches.mockRestore(); Object.defineProperty(process, 'execPath', descriptor); process.argv[1] = argv1; };
}
const stateFile = () => path.join(home, 'member', 'keep-current.json');
const args = () => ['--project', 'proj_fixture', '--server', SERVER, '--home', home];
const pass = (deps: HelperVerbDeps = {}) => runHelperVerb(args(), {
  now, lingerMs: 0, keepCurrent: () => null, pass: async () => {}, ...deps,
});
let binaryDeps: BinaryUpdateDeps;
beforeEach(() => {
  setPluginVersion(FROM);
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

it('off records one skip a day without network and doctor/status show how to turn it on', async () => {
  writeAutomaticUpdatePreference(home, false);
  let resolved = 0;
  let staged = 0;
  const deps = { ...binaryDeps,
    resolveRefs: async () => { resolved++; return null; },
    stageBinary: async () => { staged++; return { error: 'unexpected download' }; },
  };
  await pass({ binaryUpdateDeps: deps });
  const first = readAutomaticUpdate(home);
  expect(first?.lastOutcome).toEqual({ kind: 'skipped', reason: 'automatic updates are turned off' });
  clock++;
  await pass({ binaryUpdateDeps: deps });
  expect(readAutomaticUpdate(home)).toEqual(first);
  expect(resolved).toBe(0);
  expect(staged).toBe(0);
  const check = checkAutomaticUpdate(home);
  expect(check).toMatchObject({ status: 'ok', detail: 'off; run myco update --automatic on to turn automatic updates on' });
  expect((await homeReport(home, {
    cwd: root, now, fetch: async () => Response.json({}), worker: { platform: 'linux', runner: recordingPlatform().runner, ownDeploymentUrls: async () => [] },
  })).find(row => row.name === 'Automatic update')).toEqual(check);
  const lines: string[] = [];
  runStatus(['--all'], { mycoHome: home, cwd: root, now, worker: { platform: 'linux', runner: recordingPlatform().runner }, stdout: line => lines.push(line), stderr: () => {} });
  expect(lines.join('\n')).toContain(check.detail);
  expect(check.detail).not.toContain(new Date(first!.lastAttemptAt).toISOString());
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
  expect(check.detail).toContain(automaticUpdateWords(outcome));
  expect(check.status).toBe(outcome.kind === 'skipped' ? 'ok' : 'warn');
  expect((await homeReport(home, {
    cwd: root, now, fetch: async () => Response.json({}), worker: { platform: 'linux', runner: recordingPlatform().runner, ownDeploymentUrls: async () => [] },
  })).filter(row => row.name === 'Automatic update')).toEqual([check]);
  const lines: string[] = [];
  runStatus(['--all'], { mycoHome: home, cwd: root, now, worker: { platform: 'linux', runner: recordingPlatform().runner }, stdout: line => lines.push(line), stderr: () => {} });
  expect(lines.join('\n')).toContain(check.detail);
  expect(fs.readFileSync(helperLogPath(home), 'utf8')).toContain(automaticUpdateWords(outcome));
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
  setPluginVersion(TO);
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
    status: version === TO ? 'ok' : 'warn', detail: expect.stringContaining(version === TO ? 'agent setup has since been checked' : 'configuration fixture is unwritable'),
  });
});

it.each([FROM, TO, null])('keeps pending agent refresh visible while automatic updates are off, provision version %p', async version => {
  if (version !== null) recordProvision(home, { version, serverUrl: SERVER, agents: ['codex'] });
  await attemptAutomaticUpdate(home, now, async () => ({ kind: 'adopted', version: TO }), async () => { throw new Error('fixture agent refresh failed'); });
  writeAutomaticUpdatePreference(home, false);
  const check = checkAutomaticUpdate(home);
  expect(check.status).toBe(version === TO ? 'ok' : 'warn');
  expect(check.detail).toStartWith('off; run myco update --automatic on');
  expect(check.detail.includes('agents still need refreshing. Run myco member provision --refresh')).toBe(version !== TO);
  expect(check.detail).not.toContain(new Date(clock).toISOString());
  expect((await homeReport(home, {
    cwd: root, now, fetch: async () => Response.json({}), worker: { platform: 'linux', runner: recordingPlatform().runner, ownDeploymentUrls: async () => [] },
  })).find(row => row.name === 'Automatic update')).toEqual(check);
  const lines: string[] = [];
  runStatus(['--all'], { mycoHome: home, cwd: root, now, worker: { platform: 'linux', runner: recordingPlatform().runner }, stdout: line => lines.push(line), stderr: () => {} });
  expect(lines.join('\n')).toContain(check.detail);
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

it.each([false, true].flatMap(source => [true, false].flatMap(complete => [false, true].map(previous => ({ source, complete, previous })))) )('an older helper preserves another helper’s adopted setup; source = $source; refresh complete = $complete; previous slot = $previous', async ({ source, complete, previous }) => {
  const FROM = source ? '0.0.0-dev+fixture.bolder' : '2.0.0-alpha.2';
  const TO = source ? '0.0.0-dev+fixture.bnewer' : '2.0.0-alpha.3';
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
  fs.writeFileSync(live, FROM, { mode: 0o755 });
  const executable = previous ? path.join(path.dirname(live), process.platform === 'win32' ? 'myco.prev.exe' : 'myco.prev') : live;
  if (previous) fs.renameSync(live, executable);
  const restoreProcess = compiledProcess(executable);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, TO, { mode: 0o755 });
  fs.renameSync(replacement, live);
  const probe = spyOn(binaryVersion, 'readBinaryVersion').mockReturnValue(TO);
  const install = spyOn(SymbiontInstaller.prototype, 'install');
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
    expect(probe).toHaveBeenCalledWith(live, 2_000);
    expect(fs.readFileSync(helperLogPath(home), 'utf8')).toContain(`a different build of Myco is installed (${TO}); this process leaves agent setup alone.`);
  } finally { install.mockRestore(); probe.mockRestore(); restoreProcess(); }
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

it('a timestamp one year ahead is due, while five minutes of clock skew is tolerated', async () => {
  const state = (at: number) => fs.writeFileSync(stateFile(), JSON.stringify({ lastAttemptAt: at, lastOutcome: { kind: 'already-current', version: FROM } }));
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  let attempts = 0;
  const update: typeof updateBinary = async () => { attempts++; return { kind: 'already-current', version: FROM, reason: 'current' }; };
  state(clock + AUTOMATIC_UPDATE_CLOCK_SKEW_MS);
  await pass({ updateBinary: update });
  expect(attempts).toBe(0);
  state(clock + 365 * AUTOMATIC_UPDATE_INTERVAL_MS);
  await pass({ updateBinary: update });
  expect(attempts).toBe(1);
  expect(readAutomaticUpdate(home)?.lastAttemptAt).toBe(clock);
});

for (const damage of ['truncated', 'malformed', 'unreadable']) {
  for (const route of ['kick', 'sweep', 'successor', 'hook']) {
    it(`a ${damage} install marker falls back to execPath on the ${route} path`, async () => {
      const restoreProcess = compiledProcess(live);
      const marker = path.join(home, 'install.json');
      fs.writeFileSync(marker, damage === 'truncated' ? '{"channel":"alpha"' : JSON.stringify({ channel: 'alpha', source: 'curl', bin: 17 }));
      const read = fs.readFileSync;
      const denied = damage === 'unreadable' ? spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(file) === marker) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
        return Reflect.apply(read, fs, [file, ...rest]);
      }) as typeof fs.readFileSync) : null;
      const starts: string[] = [];
      const spawn = (binary: string) => { starts.push(binary); return { started: false as const }; };
      const output: string[] = [];
      const out = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write);
      const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
      const response = spyOn(hookResponse, 'writeHookResponse');
      const argv = process.argv;
      try {
        expect(resolveBinary('member-helper', { kind: 'machine' }, { mycoHome: home }).path).toBe(live);
        if (route === 'kick') {
          expect(kickHelper({ projectId: 'proj_fixture', serverUrl: SERVER, mycoHome: home, now, spawn }).kind).toBe('failed');
        } else if (route === 'sweep') {
          const spool = new MemberSpool({ projectId: 'proj_fixture', serverUrl: SERVER }, { mycoHome: home });
          spool.append('marker', promptEvent({ agent: 'claude-code', sessionId: 'marker', stage: spool.stagerFor('marker'), version: 'test' }, { promptId: 'prompt_marker', text: 'fixture' }));
          expect(kickWaitingProjects(home, 'other', { now, spawn })).toHaveLength(1);
        } else if (route === 'successor') {
          await runHelper({ projectId: 'proj_fixture', serverUrl: SERVER, mycoHome: home, now, deadlineMs: 10, spawn,
            pass: async () => { fs.writeFileSync(helperPaths('proj_fixture', home, SERVER).dirty, ''); clock += 11; },
          });
        } else {
          process.env.MYCO_HOME = home;
          process.argv = [argv[0], argv[1], 'hook', 'session-start', '--symbiont', 'claude-code'];
          _resetManifestCache();
          const transcript = path.join(root, 'marker.jsonl');
          fs.writeFileSync(transcript, JSON.stringify({ type: 'user', entrypoint: 'cli' }) + '\n');
          setBufferedStdin(Buffer.from(JSON.stringify({ session_id: 'marker', cwd: root, transcript_path: transcript })));
          await sessionStart({ credential: 'registry', argv: process.argv, env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(root, 'agent-tmp') }, helperSpawn: spawn, now, fetch: async () => Response.json({}) });
          expect(response).toHaveBeenCalledTimes(1);
          expect(err.mock.calls.flat().join('')).not.toContain('session-start error');
        }
        expect(starts, JSON.stringify(err.mock.calls)).toEqual([live]);
        expect(fs.existsSync(helperPaths('proj_fixture', home, SERVER).starting)).toBe(false);
      } finally { process.argv = argv; _resetManifestCache(); out.mockRestore(); err.mockRestore(); response.mockRestore(); denied?.mockRestore(); setBufferedStdin(null); restoreProcess(); }
    });
  }
}

it('a resolution failure releases the starting claim and leaves the kick available for inline delivery', () => {
  const resolve = spyOn(binaryResolution, 'resolveBinary').mockImplementation(() => { throw new Error('resolution fixture'); });
  try {
    expect(kickHelper({ projectId: 'proj_fixture', serverUrl: SERVER, mycoHome: home, now, spawn: () => { throw new Error('must not spawn'); } })).toEqual({ kind: 'failed' });
    expect(fs.existsSync(helperPaths('proj_fixture', home, SERVER).starting)).toBe(false);
  } finally { resolve.mockRestore(); }
});

it('one broken harness leaves healthy harnesses provisioned once and a manual refresh clears the doctor warning', async () => {
  setPluginVersion(FROM);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  recordProvision(home, { version: FROM, serverUrl: SERVER, agents: ['codex', 'gemini'] });
  await attemptAutomaticUpdate(home, now, async () => ({ kind: 'adopted', version: TO }), async () => { throw new Error('one harness cannot be repaired'); });
  expect(checkAutomaticUpdate(home).status).toBe('warn');
  setPluginVersion(TO);
  const install = spyOn(SymbiontInstaller.prototype, 'install');
  try {
    expect(runProvision(['--refresh'], { mycoHome: home, cwd: root, stdout: () => {}, stderr: () => {} })).toBe(true);
    keepCurrent(home, { binaryFound: () => true });
    const last = keepCurrent(home, { binaryFound: () => true });
    expect(install).toHaveBeenCalledTimes(1);
    expect(last?.harnesses).toContainEqual(expect.objectContaining({ id: 'gemini', state: 'repair_failed' }));
    expect(readProvisionRecord(home)?.version).toBe(TO);
    expect(checkAutomaticUpdate(home)).toMatchObject({ status: 'ok', detail: expect.stringContaining('agent setup has since been checked') });
  } finally { install.mockRestore(); }
});

it.each([false, true])('the live older release repairs newer historical setup; non-default home = %p', async nonDefault => {
  if (nonDefault) home = path.join(root, 'separately-managed');
  fs.mkdirSync(home, { recursive: true });
  writeInstallMarker(home, { bin: live, source: 'curl', channel: 'alpha' });
  setPluginVersion(TO);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  await attemptAutomaticUpdate(home, now, async () => ({ kind: 'adopted', version: TO }));
  setPluginVersion(FROM);
  const restoreProcess = compiledProcess(live);
  const probe = spyOn(binaryVersion, 'readBinaryVersion').mockReturnValue(FROM);
  const install = spyOn(SymbiontInstaller.prototype, 'install');
  try {
    expect(keepCurrent(home, { binaryFound: () => true })).not.toBeNull();
    expect(install).toHaveBeenCalledTimes(1);
    expect(readProvisionRecord(home)?.version).toBe(FROM);
    expect(probe).not.toHaveBeenCalled();
    expect(checkAutomaticUpdate(home).status).toBe('ok');
    const lines: string[] = [];
    runStatus(['--all'], { mycoHome: home, cwd: root, stdout: line => lines.push(line), stderr: () => {}, worker: { platform: 'linux', runner: recordingPlatform().runner } });
    expect(lines.join('')).not.toContain('agents still need refreshing');
  } finally { install.mockRestore(); probe.mockRestore(); restoreProcess(); }
});

it('defers agent refresh after adoption when less than the minimum refresh budget remains', async () => {
  let refreshes = 0;
  await pass({ updateBinary: async () => { clock += 120_000 - AUTOMATIC_REFRESH_MIN_BUDGET_MS + 1; return { kind: 'adopted', version: TO }; },
    refreshMember: async () => { refreshes++; },
  });
  expect(refreshes).toBe(0);
  expect(readAutomaticUpdate(home)?.lastOutcome).toMatchObject({ kind: 'adopted', reason: expect.stringContaining('refresh deferred') });
});

it('validates status arguments before printing the automatic update row and uses user words for a selected build', async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const priorExit = process.exitCode;
  try {
    runStatus(['--invalid'], { mycoHome: home, cwd: root, stdout: line => lines.push(line), stderr: line => errors.push(line) });
    expect(lines).toEqual([]);
    expect(errors).toEqual(['usage: myco member status [--all]']);
    expect(process.exitCode).toBe(2);
  } finally { process.exitCode = priorExit ?? 0; }
  await attemptAutomaticUpdate(home, now, async () => ({ kind: 'skipped', reason: `runtime pin selects another binary: ${live}` }));
  expect(checkAutomaticUpdate(home).detail).toContain(`Another Myco build is selected for this machine (${live})`);
  expect(checkAutomaticUpdate(home).detail).not.toContain('runtime pin');
});

for (const route of ['keep-current', 'refresh', 'join-reconcile']) {
  for (const fault of ['slow', 'non-zero', 'truncated', 'unreadable']) {
    it(`a ${fault} installed binary check lets ${route} repair proceed with a diagnostic`, () => {
      setPluginVersion(TO);
      writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
      provisionGlobally('codex', null, home, { serverUrl: SERVER });
      setPluginVersion(FROM);
      const restoreProcess = compiledProcess(live);
      const marker = path.join(home, 'install.json');
      if (fault === 'truncated') fs.writeFileSync(marker, '{"channel":"alpha"');
      if (fault === 'slow' || fault === 'non-zero') {
        const replacement = path.join(root, 'unprobed-release');
        fs.writeFileSync(replacement, 'fixture executable', { mode: 0o755 });
        fs.renameSync(replacement, live);
      }
      const read = fs.readFileSync;
      const denied = fault === 'unreadable' ? spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(file) === marker) throw Object.assign(new Error('marker permission denied'), { code: 'EACCES' });
        return Reflect.apply(read, fs, [file, ...rest]);
      }) as typeof fs.readFileSync) : null;
      const probe = spyOn(binaryVersion, 'readBinaryVersion').mockImplementation(() => {
        if (fault === 'slow') throw Object.assign(new Error('version check timed out'), { code: 'ETIMEDOUT' });
        throw new Error('version check exited 3');
      });
      const messages: string[] = [];
      const err = spyOn(process.stderr, 'write').mockImplementation(((line: string) => { messages.push(String(line)); return true; }) as typeof process.stderr.write);
      const warn = spyOn(console, 'warn').mockImplementation((line: unknown) => { messages.push(String(line)); });
      const install = spyOn(SymbiontInstaller.prototype, 'install');
      try {
        if (route === 'keep-current') expect(keepCurrent(home, { binaryFound: () => true })?.ready).toContain('Codex');
        else if (route === 'refresh') expect(runProvision(['--refresh'], { mycoHome: home, cwd: root, stdout: () => {}, stderr: () => {} })).toBe(true);
        else expect(provisionAgents(['codex'], home, SERVER, null).skipped).toEqual([]);
        expect(install).toHaveBeenCalledTimes(1);
        expect(readProvisionRecord(home)?.version).toBe(FROM);
        expect(messages.join('')).toContain('The installed Myco version could not be checked');
        expect(messages.join('')).toContain('agent repair will continue using this build');
        if (fault === 'slow' || fault === 'non-zero') expect(probe).toHaveBeenCalledWith(live, 2_000);
        else {
          expect(probe).not.toHaveBeenCalled();
          expect(() => binaryUpdatePath(home)).toThrow();
        }
      } finally { install.mockRestore(); warn.mockRestore(); err.mockRestore(); probe.mockRestore(); denied?.mockRestore(); restoreProcess(); }
    });
  }
}

it('an unchanged live executable repairs repeated passes without starting a version probe', () => {
  setPluginVersion(TO);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  setPluginVersion(FROM);
  const restoreProcess = compiledProcess(live);
  const probe = spyOn(binaryVersion, 'readBinaryVersion').mockImplementation(() => { throw new Error('the running file needs no cold start'); });
  const install = spyOn(SymbiontInstaller.prototype, 'install');
  try {
    expect(keepCurrent(home, { binaryFound: () => true })?.ready).toContain('Codex');
    expect(keepCurrent(home, { binaryFound: () => true })?.ready).toContain('Codex');
    expect(install).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(readProvisionRecord(home)?.version).toBe(FROM);
  } finally { install.mockRestore(); probe.mockRestore(); restoreProcess(); }
});

it('file identity uses device/inode and Windows file index or creation timestamps', () => {
  const stat = fs.statSync;
  const template = stat(live);
  let current = { dev: 1, ino: 1, ctimeMs: 10, birthtimeMs: 10 };
  const mockStat = spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
    if (String(file) === live) return Object.assign(Object.create(Object.getPrototypeOf(template)), template, current);
    return Reflect.apply(stat, fs, [file, ...rest]);
  }) as typeof fs.statSync);
  try {
    const posix = binaryResolution.captureExecutableIdentity(live, 'linux');
    current = { ...current, ctimeMs: 20 };
    expect(posix(live)).toBe(true);
    current = { ...current, ino: 2 };
    expect(posix(live)).toBe(false);
    current = { ...current, dev: 2, ino: 1 };
    expect(posix(live)).toBe(false);
    const windows = binaryResolution.captureExecutableIdentity(live, 'win32');
    current = { ...current, ino: 2 };
    expect(windows(live)).toBe(false);
    current = { dev: 1, ino: 0, ctimeMs: 30, birthtimeMs: 30 };
    const fallback = binaryResolution.captureExecutableIdentity(live, 'win32');
    expect(fallback(live)).toBe(true);
    current = { ...current, ctimeMs: 31 };
    expect(fallback(live)).toBe(false);
    current = { ...current, ctimeMs: 30, birthtimeMs: 31 };
    expect(fallback(live)).toBe(false);
  } finally { mockStat.mockRestore(); }
});
