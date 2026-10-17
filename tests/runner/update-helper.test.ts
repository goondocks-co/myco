import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runRunnerUpdateHelper, HELPER_INSTALLATION_WAIT_MS, type RunnerUpdateHelperDeps } from '../../packages/myco/src/runner/update-helper.js';
import { readRunnerUpdateState, runnerUpdateStatePath, strictRunnerReleaseProbe, withRunnerUpdateState, type RunnerUpdateTransaction } from '../../packages/myco/src/runner/update.js';
import { versionBinaryPath, writeInstallMarker } from '../../packages/myco/src/install/managed-binary.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { acquireInstallationLease, beginBinaryPublication, publishAdoptedMarker } from '../../packages/myco/src/install/adoption.js';
import { placeExecutable } from '../../packages/myco/src/install/place-binary.js';
import type { ServiceSpec } from '../../packages/myco/src/server/service.js';
import { withManagedMemberHarnesses } from '@myco/cli/member.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-helper-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const from = '2.0.0-alpha.1';
const to = '2.0.0-alpha.2';
const serverUrl = 'https://deployment.invalid';

function fixture(label: string) {
  const home = path.join(root, label);
  const binaryPath = path.join(home, 'service', 'myco');
  const previous = versionBinaryPath(home, 'linux', from);
  const target = versionBinaryPath(home, 'linux', to);
  for (const file of [binaryPath, previous, target]) fs.mkdirSync(path.dirname(file), { recursive: true });
  const oldBytes = `#!/bin/sh\nprintf '%s\\n' '${from}'\n`;
  fs.writeFileSync(binaryPath, oldBytes, { mode: 0o755 });
  fs.writeFileSync(previous, oldBytes, { mode: 0o755 });
  fs.writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' '${to}'\n`, { mode: 0o755 });
  const installMarker = { channel: 'alpha' as const, source: 'curl' as const, bin: binaryPath, prerelease: true };
  writeInstallMarker(home, installMarker);
  const serviceSpec: ServiceSpec = {
    binaryPath, home, logDir: home, pathEnv: '', env: { MYCO_HOME: home },
    unit: { label: 'fixture', unitName: 'fixture', description: 'fixture', args: ['runner', 'run'], logName: 'fixture', restartDelaySeconds: 1 },
  };
  const tx: RunnerUpdateTransaction = {
    id: `tx-${label}`, serverUrl, fromVersion: from, toVersion: to, binaryPath, home,
    platform: 'linux', serviceSpec, installMarker, ownerPid: 12345, startedAt: 1000,
    deadlineAt: 1_000_000, phase: 'waiting',
  };
  withRunnerUpdateState(home, state => { state.transaction = tx; });
  let time = 1000;
  let running = true;
  let stops = 0;
  let starts = 0;
  const deps: RunnerUpdateHelperDeps = {
    now: () => time,
    wait: async () => { time += 10_000; },
    alive: pid => pid !== tx.ownerPid,
    stopped: () => !running,
    stop: () => { stops++; running = false; },
    start: () => { starts++; running = true; return { unitFile: 'fixture', loaded: true, running: true, changed: true }; },
    probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
    removeGuardian: () => { throw new Error('no guardian service should be invoked by this fixture'); },
  };
  return { home, binaryPath, previous, target, tx, deps, get time() { return time; },
    get stops() { return stops; }, get starts() { return starts; }, setRunning(value: boolean) { running = value; } };
}

describe('runner update helper', () => {
  for (const outcome of ['orphaned', 'updated', 'refused', 'rolled_back', 'recovered-rollback'] as const) {
    it(`exits cleanly when ${outcome} cleanup is held by another holder`, async () => {
      const f = fixture(`cleanup-contended-${outcome}`);
      if (outcome === 'orphaned') {
        withRunnerUpdateState(f.home, state => {
          delete state.transaction;
          state.lastResults = { [serverUrl]: { fromVersion: from, toVersion: to, result: 'updated', at: f.time } };
          state.cleanup = { currentVersion: to, previousVersion: from, platform: 'linux' };
        });
      } else if (outcome === 'updated') {
        withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
      } else if (outcome === 'refused') {
        f.deps.probe = () => ({ runs: false, detail: 'candidate no longer verifies' });
      } else if (outcome === 'rolled_back') {
        withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'adopted'; state.transaction!.healthRefusal = 'runner credential refused'; });
      } else {
        withRunnerUpdateState(f.home, state => {
          state.transaction!.phase = 'rollback';
          state.transaction!.failureReason = 'runner credential refused';
          state.transaction!.rollbackResult = 'rolled_back';
        });
      }
      let prunes = 0;
      f.deps.prune = () => { prunes++; };
      const held = LifecycleLock.acquire(path.join(f.home, 'runner', '.update-cleanup.lock'));
      if (!held.acquired) throw new Error('cleanup holder did not acquire its lock');
      try {
        await expect(runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps)).resolves.toBeUndefined();
        const state = readRunnerUpdateState(f.home);
        expect(state.transaction).toBeUndefined();
        expect(state.lastResults?.[serverUrl]?.result).toBe(outcome === 'orphaned' ? 'updated' : outcome === 'recovered-rollback' ? 'rolled_back' : outcome);
        expect(state.cleanup).toBeDefined();
        expect(state.cleanupFailures).toBeUndefined();
        expect(state.cleanupReason).toBeUndefined();
        expect(state.nextCleanupAt).toBeUndefined();
        expect(prunes).toBe(0);
      } finally { held.lock.release(); }
      const results = readRunnerUpdateState(f.home).lastResults;
      await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
      expect(readRunnerUpdateState(f.home).cleanup).toBeUndefined();
      expect(readRunnerUpdateState(f.home).lastResults).toEqual(results);
      expect(prunes).toBe(1);
    });
  }

  it('refuses a staged candidate that fails its handoff probe before stopping the original service', async () => {
    const f = fixture('candidate-probe');
    const before = fs.statSync(f.binaryPath).ino;
    const bytes = fs.readFileSync(f.binaryPath);
    f.deps.probe = () => ({ runs: false, detail: 'candidate no longer verifies' });
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.statSync(f.binaryPath).ino).toBe(before);
    expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
    expect(f.stops).toBe(0);
    expect(f.starts).toBe(0);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('refused');
  });

  it('refuses a copied candidate at placement without replacing the installed inode', async () => {
    const f = fixture('placement-probe');
    const before = fs.statSync(f.binaryPath).ino;
    const bytes = fs.readFileSync(f.binaryPath);
    f.deps.probe = file => path.basename(path.dirname(file)).startsWith('.myco-place-')
      ? { runs: false, detail: 'copied candidate cannot run' } : { runs: true };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.statSync(f.binaryPath).ino).toBe(before);
    expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
    expect(f.stops).toBe(1);
    expect(f.starts).toBe(1);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('refused');
  });

  it('does not stop or replace the old service after the handoff deadline', async () => {
    const f = fixture('deadline');
    const before = fs.statSync(f.binaryPath).ino;
    withRunnerUpdateState(f.home, state => { state.transaction!.deadlineAt = 1000; });
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.statSync(f.binaryPath).ino).toBe(before);
    expect(f.stops).toBe(0);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('refused');
  });

  it('restarts the original service without adoption when the handoff is canceled after stop', async () => {
    const f = fixture('canceled');
    const before = fs.statSync(f.binaryPath).ino;
    f.deps.stop = () => {
      f.setRunning(false);
      withRunnerUpdateState(f.home, state => { delete state.transaction; });
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.statSync(f.binaryPath).ino).toBe(before);
    expect(f.starts).toBe(1);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toBeUndefined();
  });

  it('keeps the installed inode when cancellation arrives during the candidate probe', async () => {
    const f = fixture('canceled-during-probe');
    const before = fs.statSync(f.binaryPath).ino;
    const bytes = fs.readFileSync(f.binaryPath);
    f.deps.probe = file => {
      if (file === f.target) {
        withRunnerUpdateState(f.home, state => { delete state.transaction; });
      }
      return { runs: true };
    };
    f.deps.start = () => {
      expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
      f.setRunning(true);
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.statSync(f.binaryPath).ino).toBe(before);
    expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toBeUndefined();
  });

  it('serializes placement with the adopted journal transition against a competing cancellation', async () => {
    const f = fixture('serialized-placement');
    let denied = false;
    f.deps.place = (source, dest, options) => {
      try { withRunnerUpdateState(f.home, state => { delete state.transaction; }); }
      catch (error) {
        expect(String(error)).toContain('another runner update holds the machine binary');
        denied = true;
      }
      placeExecutable(source, dest, options);
    };
    f.deps.start = () => {
      f.setRunning(true);
      withRunnerUpdateState(f.home, state => {
        if (state.transaction?.phase === 'adopted') {
          state.transaction.phase = 'probation';
          state.transaction.startedPid = 22222;
          state.transaction.contactAt = f.time;
          state.transaction.completedClaimAt = f.time;
        }
      });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(denied).toBe(true);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('updated');
  });

  it('keeps the installed inode when the deadline passes during the placement probe', async () => {
    const f = fixture('deadline-during-probe');
    const before = fs.statSync(f.binaryPath).ino;
    let tick = 1000;
    f.deps.now = () => tick;
    withRunnerUpdateState(f.home, state => { state.transaction!.deadlineAt = 1500; });
    f.deps.probe = file => {
      if (path.basename(path.dirname(file)).startsWith('.myco-place-')) tick = 1500;
      return { runs: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.statSync(f.binaryPath).ino).toBe(before);
    expect(f.starts).toBe(1);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('refused');
  });

  it('restores after an unreachable health window without blocking the release', async () => {
    const f = fixture('unreachable');
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({ result: 'failed', reason: 'updated runner did not make authenticated contact' });
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeUndefined();
  });

  it('rolls back and temporarily blocks a release whose restarted service refuses to start', async () => {
    const f = fixture('start-refusal');
    let calls = 0;
    f.deps.start = () => ({ unitFile: 'fixture', loaded: true, running: ++calls > 1, changed: true });
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(calls).toBe(2);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('rolled_back');
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]?.until).toBeGreaterThan(f.time);
  });

  it('rolls back when the contacted new process dies during probation', async () => {
    const f = fixture('post-contact-crash');
    f.deps.start = () => {
      f.setRunning(true);
      withRunnerUpdateState(f.home, state => {
        if (state.transaction?.phase === 'adopted') {
          state.transaction.phase = 'probation';
          state.transaction.startedPid = 22222;
          state.transaction.contactAt = f.time;
        }
      });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    f.deps.alive = pid => pid !== f.tx.ownerPid && pid !== 22222;
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('rolled_back');
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeDefined();
  });

  it('rolls back when authenticated contact explicitly refuses the new process', async () => {
    const f = fixture('contact-refusal');
    f.deps.start = () => {
      f.setRunning(true);
      withRunnerUpdateState(f.home, state => {
        if (state.transaction?.phase === 'adopted') state.transaction.healthRefusal = 'runner credential refused';
      });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({ result: 'rolled_back', reason: 'updated runner contact was refused: runner credential refused' });
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeDefined();
  });

  it('commits after authenticated contact and a completed claim', async () => {
    const f = fixture('claim-complete');
    f.deps.start = () => {
      f.setRunning(true);
      withRunnerUpdateState(f.home, state => {
        if (state.transaction?.phase === 'adopted') {
          state.transaction.phase = 'probation';
          state.transaction.startedPid = 22222;
          state.transaction.contactAt = f.time;
          state.transaction.completedClaimAt = f.time;
        }
      });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('updated');
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeUndefined();
  });

  it('keeps an open first claim under probation past five minutes and rolls back if its process dies', async () => {
    const f = fixture('open-claim-crash');
    let tick = 1000;
    let waits = 0;
    let crashed = false;
    f.deps.now = () => tick;
    f.deps.wait = async () => {
      waits++;
      if (waits === 1) tick += 5 * 60_000;
      else {
        expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('probation');
        expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toBeUndefined();
        crashed = true;
        tick += 1000;
      }
    };
    f.deps.alive = pid => pid !== f.tx.ownerPid && !crashed;
    f.deps.start = () => {
      f.setRunning(true);
      withRunnerUpdateState(f.home, state => {
        if (state.transaction?.phase === 'adopted') {
          state.transaction.phase = 'probation';
          state.transaction.startedPid = 22222;
          state.transaction.contactAt = tick;
          state.transaction.firstClaimAt = tick;
        }
      });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(waits).toBeGreaterThanOrEqual(2);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('rolled_back');
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
  });

  it('holds a contacted runner in probation until the bounded window ends', async () => {
    const f = fixture('probation-window');
    let tick = 1000;
    f.deps.now = () => tick;
    f.deps.wait = async () => {
      expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('probation');
      expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toBeUndefined();
      tick += 5 * 60_000;
    };
    f.deps.start = () => {
      f.setRunning(true);
      withRunnerUpdateState(f.home, state => {
        if (state.transaction?.phase === 'adopted') {
          state.transaction.phase = 'probation';
          state.transaction.startedPid = 22222;
          state.transaction.contactAt = tick;
        }
      });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    };
    await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
    expect(tick).toBeGreaterThanOrEqual(1000 + 5 * 60_000);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('updated');
  });
});

it('leaves member refresh pending after a healthy runner update without running interactive setup', async () => {
  const f = fixture('member-refresh-failed');
  writeDeploymentMembership({ serverUrl, token: 'fixture', machineId: 'member', joinedAt: 1, updatedAt: 1 }, { mycoHome: f.home });
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({
    result: 'updated', reason: 'agents_refresh_pending',
  });
  expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
});

it('restores binary and source marker after interrupted runner publication', async () => {
  const f = fixture('interrupted-source-publication');
  const sourceVersion = '0.0.0-dev+commit.bprevious';
  const sourceMarker = { source: 'checkout' as const, channel: 'alpha' as const,
    checkout: f.home, commit: 'a'.repeat(40), version: sourceVersion,
    binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(f.previous)).digest('hex'), bin: f.binaryPath };
  withRunnerUpdateState(f.home, state => {
    state.transaction!.phase = 'placing';
    state.transaction!.installMarker = sourceMarker;
  });
  fs.copyFileSync(f.target, f.binaryPath);
  writeInstallMarker(f.home, { channel: 'alpha', source: 'curl', bin: f.binaryPath, version: to });
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(fs.readFileSync(f.binaryPath)).toEqual(fs.readFileSync(f.previous));
  expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toEqual(sourceMarker);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({
    result: 'failed', reason: 'runner binary publication was interrupted',
  });
});

it('waits for a held Windows executable owner and stops its service before local placement', async () => {
  const f = fixture('windows-held-source');
  const version = '0.0.0-dev+commit.bwindows';
  const slot = crypto.randomUUID();
  const candidate = path.join(f.home, 'runner', 'candidates', slot, 'myco.exe');
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  withRunnerUpdateState(f.home, state => {
    state.transaction!.platform = 'win32';
    state.transaction!.toVersion = version;
    state.transaction!.localCandidate = {
      kind: 'local', platform: 'win32', version, binaryPath: candidate, slot, checkout: f.home,
      commit: 'a'.repeat(40), sha256: crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'),
    };
  });
  let ownerHeld = true;
  let waits = 0;
  let placed = false;
  f.deps.alive = () => ownerHeld;
  f.deps.wait = async () => {
    expect(placed).toBe(false);
    expect(f.stops).toBe(0);
    if (++waits === 2) ownerHeld = false;
  };
  f.deps.place = (src, dest, opts) => {
    expect(ownerHeld).toBe(false);
    expect(f.stops).toBe(1);
    expect(opts?.platform).toBe('win32');
    placed = true;
    placeExecutable(src, dest, { ...opts, platform: 'linux' });
  };
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(waits).toBe(2);
  expect(placed).toBe(true);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({
    result: 'updated', toVersion: version,
  });
  expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toMatchObject({
    source: 'checkout', version, binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(f.binaryPath)).digest('hex'),
  });
});

it('refuses a waiting handoff whose from-version no longer matches live bytes', async () => {
  const f = fixture('stale-from-version');
  fs.writeFileSync(f.binaryPath, `#!/bin/sh\nprintf '%s\\n' '2.0.0-alpha.9'\n`, { mode: 0o755 });
  publishAdoptedMarker(f.home, f.binaryPath, '2.0.0-alpha.9', { kind: 'release' });
  const bytes = fs.readFileSync(f.binaryPath);
  const marker = fs.readFileSync(path.join(f.home, 'install.json'));
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(f.stops).toBe(0);
  expect(f.starts).toBe(0);
  expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
  expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({ result: 'refused' });
});

it('recovers pending main publication before probing the waiting helper from-version', async () => {
  const f = fixture('helper-main-publication-recovery');
  const previous = path.join(path.dirname(f.binaryPath), 'myco.prev');
  beginBinaryPublication(f.home, f.binaryPath, previous);
  fs.renameSync(f.binaryPath, previous);
  fs.writeFileSync(f.binaryPath, `#!/bin/sh\nprintf '%s\\n' '2.0.0-alpha.9'\n`, { mode: 0o755 });
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({ result: 'updated' });
  expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
  expect(fs.existsSync(path.join(f.home, 'install-adoption.json'))).toBe(false);
});

it('releases the helper lock when installation lease acquisition throws', async () => {
  const f = fixture('installation-acquire-throws');
  const acquire = LifecycleLock.acquire;
  const injected = spyOn(LifecycleLock, 'acquire').mockImplementation((file, options) => {
    if (options?.command === 'myco runner update helper installation') throw new Error('installation lease unavailable');
    return acquire(file, options);
  });
  try { await expect(runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps)).rejects.toThrow('installation lease unavailable'); }
  finally { injected.mockRestore(); }
  const retry = LifecycleLock.acquire(path.join(f.home, 'runner', '.update-helper.lock'));
  expect(retry.acquired).toBe(true);
  if (retry.acquired) retry.lock.release();
  expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('waiting');
});

it('waits for a short installation collision and then completes the handoff', async () => {
  const f = fixture('short-installation-collision');
  const held = acquireInstallationLease(f.home);
  if (!held.acquired) throw new Error('fixture lease unavailable');
  let waits = 0;
  f.deps.wait = async () => { waits++; held.release(); };
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  try { await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps); }
  finally { held.release(); }
  expect(waits).toBe(1);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('updated');
});

it('logs a bounded installation wait without ending the queued handoff', async () => {
  const f = fixture('bounded-installation-wait');
  const held = acquireInstallationLease(f.home);
  if (!held.acquired) throw new Error('fixture lease unavailable');
  let waited = 0;
  const logs: string[] = [];
  f.deps.wait = async ms => { waited += ms; };
  f.deps.log = line => logs.push(line);
  const start = f.deps.start!;
  f.deps.start = (spec, platform) => {
    const outcome = start(spec, platform);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return outcome;
  };
  try { await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps); }
  finally { held.release(); }
  expect(waited).toBe(HELPER_INSTALLATION_WAIT_MS);
  expect(logs).toEqual([expect.stringContaining('another Myco setup or update')]);
  expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('waiting');
  expect(f.stops).toBe(0);
});

it('allows member provisioning during runner probation', async () => {
  const f = fixture('provision-during-probation');
  const restoreHome = bindSandboxChildHome(f.home);
  writeDeploymentMembership({ serverUrl, token: 'fixture', machineId: 'member', joinedAt: 1, updatedAt: 1 }, { mycoHome: f.home });
  recordProvision(f.home, { version: to, serverUrl, agents: [] });
  let provisions = 0;
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'probation'; state.transaction!.contactAt = f.time; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  f.deps.wait = async () => {
    expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('probation');
    const result = withManagedMemberHarnesses(f.home, { serverUrl, wait: true, packageRoot: path.resolve('packages/myco') }, () => {
      provisions++;
      return 'provisioned';
    });
    expect(result).toBe('provisioned');
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
  };
  try { await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps); }
  finally { restoreHome(); }
  expect(provisions).toBe(1);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]?.result).toBe('updated');
});

it('rechecks checkout agreement after idle admission and before local helper placement', async () => {
  const f = fixture('helper-checkout-recheck');
  const version = '0.0.0-dev+commit.brechecked';
  const slot = crypto.randomUUID();
  const candidate = path.join(f.home, 'runner', 'candidates', slot, 'myco');
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  const marker = { channel: 'alpha' as const, source: 'checkout' as const, bin: f.binaryPath,
    checkout: f.home, commit: 'a'.repeat(40), version: '0.0.0-dev+commit.boriginal',
    binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(f.binaryPath)).digest('hex') };
  writeInstallMarker(f.home, marker);
  withRunnerUpdateState(f.home, state => {
    state.transaction!.installMarker = marker;
    state.transaction!.toVersion = version;
    state.transaction!.localCandidate = { kind: 'local', platform: 'linux', version, slot, binaryPath: candidate,
      checkout: f.home, commit: 'b'.repeat(40), sha256: crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex') };
  });
  fs.appendFileSync(f.binaryPath, '# changed bytes with the same version\n');
  const bytes = fs.readFileSync(f.binaryPath);
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(f.stops).toBe(0);
  expect(f.starts).toBe(0);
  expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({ result: 'refused', reason: expect.stringContaining('Run `myco update`') });
});

it('rechecks health after waiting to finish a runner update', async () => {
  const f = fixture('finish-health-recheck');
  let contender: { release(): void } | undefined;
  f.deps.start = () => {
    f.setRunning(true);
    if (fs.readFileSync(f.binaryPath, 'utf8').includes(to)) {
      withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
      const held = acquireInstallationLease(f.home);
      if (!held.acquired) throw new Error('helper kept the lease during service start');
      contender = held;
    }
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  f.deps.wait = async () => {
    withRunnerUpdateState(f.home, state => { state.transaction!.healthRefusal = 'contact refused while finishing'; });
    contender?.release();
    contender = undefined;
  };
  try { await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps); }
  finally { contender?.release(); }
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({ result: 'rolled_back', reason: expect.stringContaining('contact refused') });
  expect(fs.readFileSync(f.binaryPath)).toEqual(fs.readFileSync(f.previous));
});
