import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRunnerUpdateHelper, type RunnerUpdateHelperDeps } from '../../packages/myco/src/runner/update-helper.js';
import { readRunnerUpdateState, runnerUpdateStatePath, strictRunnerReleaseProbe, withRunnerUpdateState, type RunnerUpdateTransaction } from '../../packages/myco/src/runner/update.js';
import { versionBinaryPath, writeInstallMarker } from '../../packages/myco/src/install/managed-binary.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { placeExecutable } from '../../packages/myco/src/install/place-binary.js';
import type { ServiceSpec } from '../../packages/myco/src/server/service.js';

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

it('retains a failed member refresh and its recovery command after a healthy runner update', async () => {
  const f = fixture('member-refresh-failed');
  writeDeploymentMembership({ serverUrl, token: 'fixture', machineId: 'member', joinedAt: 1, updatedAt: 1 }, { mycoHome: f.home });
  f.deps.refreshMember = async () => { throw new Error('refresh timed out'); };
  f.deps.start = () => {
    f.setRunning(true);
    withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    return { unitFile: 'fixture', loaded: true, running: true, changed: true };
  };
  await runRunnerUpdateHelper(runnerUpdateStatePath(f.home), f.deps);
  expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toMatchObject({
    result: 'updated', reason: 'Agents refreshed: no (Error: refresh timed out). Next: myco member provision --refresh',
  });
  expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
});
