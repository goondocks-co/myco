/** Detached runner update handoff and authenticated-contact health rollback. */
import { isMemberHome } from '../member/home-role.js';
import path from 'node:path';
import semver from 'semver';
import { placeExecutable } from '../install/place-binary.js';
import { versionBinaryPath, writeInstallMarker } from '../install/managed-binary.js';
import { pruneVersions } from '../upgrade/apply-binary.js';
import { startService, statusOfService, stopService, type ServiceOutcome, type ServiceSpec } from '../server/service.js';
import { blockRunnerUpdateVersion, cleanupRunnerUpdateGuardian, readRunnerUpdateState, runnerCurrentReleaseProbe, runnerUpdateStatePath, strictRunnerReleaseProbe, withRunnerUpdateState, type RunnerUpdateTransaction, type RunnerUpdateReceipt } from './update.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';

const OLD_EXIT_WAIT_MS = 60_000;
const HEALTH_WAIT_MS = 90_000;
const PROBATION_WAIT_MS = 5 * 60_000;
const POLL_MS = 500;

class AdoptionRefusal extends Error {}
class HealthRollback extends Error {}
class HandoffCanceled extends Error {}

export interface RunnerUpdateHelperDeps {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  stop?: (spec: ServiceSpec, platform: NodeJS.Platform) => void;
  start?: (spec: ServiceSpec, platform: NodeJS.Platform) => ServiceOutcome;
  stopped?: (spec: ServiceSpec, platform: NodeJS.Platform) => boolean;
  place?: typeof placeExecutable;
  probe?: typeof strictRunnerReleaseProbe;
  prune?: typeof pruneVersions;
  removeGuardian?: (spec: ServiceSpec, platform: NodeJS.Platform) => void;
}
const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function receipt(tx: RunnerUpdateTransaction, result: RunnerUpdateReceipt['result'], reason: string | undefined, at: number): RunnerUpdateReceipt {
  return { ...(tx.requestId ? { requestId: tx.requestId } : {}), ...(tx.attemptId ? { attemptId: tx.attemptId } : {}),
    fromVersion: tx.fromVersion, toVersion: tx.toVersion,
    result, ...(reason ? { reason } : {}), at };
}

function finish(tx: RunnerUpdateTransaction, result: RunnerUpdateReceipt['result'], reason: string | undefined, at: number): void {
  withRunnerUpdateState(tx.home, (state) => {
    if (state.transaction?.id !== tx.id) throw new Error(`runner update ${tx.id} lost its transaction`);
    (state.lastResults ??= {})[tx.serverUrl] = receipt(tx, result, reason, at);
    if (result === 'rolled_back') blockRunnerUpdateVersion(state, tx.toVersion, reason ?? 'updated runner failed health', at);
    state.cleanup = {
      currentVersion: result === 'updated' ? tx.toVersion : tx.fromVersion,
      ...(result === 'updated' ? { previousVersion: tx.fromVersion } : { failedVersion: tx.toVersion }),
      platform: tx.platform, serverUrl: tx.serverUrl, fromVersion: tx.fromVersion, toVersion: tx.toVersion,
      ...(tx.attemptId ? { attemptId: tx.attemptId } : {}),
      ...(tx.localAppData ? { localAppData: tx.localAppData } : {}),
    };
    delete state.transaction;
  });
}
/** Called only by the hidden CLI verb under the update guardian service. */
export async function runRunnerUpdateHelper(file: string, deps: RunnerUpdateHelperDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? defaultWait;
  const alive = deps.alive ?? defaultAlive;
  const stop = deps.stop ?? ((spec, platform) => stopService(spec, { platform }));
  const start = deps.start ?? ((spec, platform) => startService(spec, { platform }));
  const stopped = deps.stopped ?? ((spec, platform) => !statusOfService(spec, { platform }).running);
  const place = deps.place ?? placeExecutable;
  const probe = deps.probe ?? strictRunnerReleaseProbe;
  const currentProbe = runnerCurrentReleaseProbe;
  const home = path.dirname(path.dirname(file));
  if (path.resolve(file) !== path.resolve(runnerUpdateStatePath(home))) throw new Error('Invalid runner update handoff path');
  const state = readRunnerUpdateState(home);
  const tx = state.transaction;
  if (tx !== undefined && (tx.home !== home || !path.isAbsolute(tx.binaryPath)
    || tx.serviceSpec.binaryPath !== tx.binaryPath || (deps.alive === undefined && tx.ownerPid === process.pid))) throw new Error('Invalid runner update handoff');
  const held = LifecycleLock.acquire(path.join(home, 'runner', '.update-helper.lock'), { command: 'myco runner update helper' });
  if (!held.acquired) return;
  try {
  if (tx === undefined) { cleanupRunnerUpdateGuardian(home, process.platform, deps); return; }
  const current = readRunnerUpdateState(home).transaction;
  if (current?.id !== tx.id) throw new Error('Runner update handoff changed');

  const target = versionBinaryPath(tx.home, tx.platform, tx.toVersion, tx.localAppData);
  const previous = versionBinaryPath(tx.home, tx.platform, tx.fromVersion, tx.localAppData);
  const placeRelease = (source: string, version: string, ready: typeof strictRunnerReleaseProbe, verifyState: () => void): void => place(source, tx.binaryPath, {
    platform: tx.platform,
    ready: file => {
      const result = ready(file, version, tx.platform);
      if (result.runs) verifyState();
      return result;
    },
  });
  const assertPhase = (observed: RunnerUpdateTransaction | undefined, phase: RunnerUpdateTransaction['phase']): void => {
    if (observed?.id !== tx.id || observed.phase !== phase) throw new HandoffCanceled('runner update handoff was canceled');
    if (phase !== 'rollback' && observed.deadlineAt !== undefined && now() >= observed.deadlineAt) {
      throw new AdoptionRefusal('runner update handoff deadline elapsed');
    }
  };
  const active = (phase: RunnerUpdateTransaction['phase']): void => assertPhase(readRunnerUpdateState(tx.home).transaction, phase);
  const rollbackActive = (): void => active('rollback');
  const restore = (reason: string, result: 'rolled_back' | 'failed'): void => {
    stop(tx.serviceSpec, tx.platform);
    if (!stopped(tx.serviceSpec, tx.platform)) throw new Error('runner service did not stop for rollback');
    const ready = currentProbe(previous, tx.fromVersion, tx.platform);
    if (!ready.runs) throw new Error(`previous binary cannot run: ${ready.detail}`);
    withRunnerUpdateState(tx.home, next => {
      assertPhase(next.transaction, 'rollback');
      placeRelease(previous, tx.fromVersion, currentProbe, rollbackActive);
    });
    const restored = start(tx.serviceSpec, tx.platform);
    if (!restored.running) throw new Error(restored.detail ?? 'restored runner service did not start');
    writeInstallMarker(tx.home, tx.installMarker);
    finish(tx, result, reason, now());
    cleanupRunnerUpdateGuardian(tx.home, tx.platform, deps);
  };
  if (current.phase === 'rollback') {
    restore(current.failureReason ?? 'runner update is rolling back', current.rollbackResult ?? 'rolled_back');
    return;
  }
  let adopted = current.phase !== 'waiting';
  let finished = false;
  try {
    if (current.phase === 'waiting') {
      const started = now();
      while (alive(tx.ownerPid) && now() - started < OLD_EXIT_WAIT_MS) { active('waiting'); await wait(POLL_MS); }
      if (alive(tx.ownerPid)) throw new AdoptionRefusal('the previous runner did not exit');
      active('waiting');
      const ready = probe(target, tx.toVersion, tx.platform);
      if (!ready.runs) throw new AdoptionRefusal(ready.detail);
      active('waiting');
      stop(tx.serviceSpec, tx.platform);
      if (!stopped(tx.serviceSpec, tx.platform)) throw new Error('runner service did not stop');
      active('waiting');
      try {
        withRunnerUpdateState(tx.home, next => {
          assertPhase(next.transaction, 'waiting');
          placeRelease(target, tx.toVersion, probe, () => active('waiting'));
          next.transaction!.phase = 'adopted';
          adopted = true;
        });
      }
      catch (error) {
        if (error instanceof HandoffCanceled || error instanceof AdoptionRefusal) throw error;
        throw new AdoptionRefusal(error instanceof Error ? error.message : String(error));
      }
      active('adopted');
      withRunnerUpdateState(tx.home, (next) => { if (next.transaction?.id === tx.id) next.transaction.startAttempts = (next.transaction.startAttempts ?? 0) + 1; });
      const startedService = start(tx.serviceSpec, tx.platform);
      if (!startedService.running) throw new HealthRollback(startedService.detail ?? 'runner service did not start');
    } else if (current.phase === 'adopted' && stopped(tx.serviceSpec, tx.platform)) {
      if ((current.startAttempts ?? 0) > 0) throw new HealthRollback('updated runner stopped before authenticated contact');
      active('adopted');
      withRunnerUpdateState(tx.home, (next) => { if (next.transaction?.id === tx.id) next.transaction.startAttempts = 1; });
      const restarted = start(tx.serviceSpec, tx.platform);
      if (!restarted.running) throw new HealthRollback(restarted.detail ?? 'updated runner service did not restart');
    }
    const healthStart = now();
    for (;;) {
      const observed = readRunnerUpdateState(tx.home).transaction;
      if (observed?.id !== tx.id) throw new Error('runner update handoff changed during health watch');
      if (observed.healthRefusal) throw new HealthRollback(`updated runner contact was refused: ${observed.healthRefusal}`);
      if (observed.startedPid !== undefined && !alive(observed.startedPid)) throw new HealthRollback('updated runner exited during health probation');
      if (stopped(tx.serviceSpec, tx.platform)) throw new HealthRollback('updated runner service stopped during health probation');
      if (observed.phase === 'healthy' || (observed.phase === 'probation' &&
        ((observed.completedClaimAt !== undefined && observed.completedClaimAt >= (observed.contactAt ?? 0))
          || (observed.firstClaimAt === undefined && now() - (observed.contactAt ?? healthStart) >= PROBATION_WAIT_MS)))) {
        writeInstallMarker(tx.home, { ...tx.installMarker, bin: tx.binaryPath, prerelease: semver.prerelease(tx.toVersion) !== null });
        const refreshPending = isMemberHome(tx.home);
        console.log(refreshPending
          ? 'Agents refreshed: no (interactive refresh pending). Next: myco update or myco member provision --refresh'
          : 'Agents refreshed: no (this home is not a member machine).');
        finish(tx, 'updated', refreshPending ? 'agents_refresh_pending' : undefined, now());
        finished = true;
        cleanupRunnerUpdateGuardian(tx.home, tx.platform, deps);
        return;
      }
      if (observed.phase !== 'probation' && now() - healthStart >= HEALTH_WAIT_MS) throw new Error('updated runner did not make authenticated contact');
      await wait(POLL_MS);
    }
  } catch (error) {
    if (finished) throw error;
    if (error instanceof HandoffCanceled || readRunnerUpdateState(tx.home).transaction?.id !== tx.id) {
      if (!adopted && stopped(tx.serviceSpec, tx.platform)) start(tx.serviceSpec, tx.platform);
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (!adopted) {
      if (stopped(tx.serviceSpec, tx.platform)) {
        const resumed = start(tx.serviceSpec, tx.platform);
        if (!resumed.running) throw new Error(resumed.detail ?? 'original runner service did not restart');
      }
      finish(tx, error instanceof AdoptionRefusal ? 'refused' : 'failed', reason, now());
      finished = true;
      cleanupRunnerUpdateGuardian(tx.home, tx.platform, deps);
      return;
    }
    const result = error instanceof HealthRollback ? 'rolled_back' : 'failed';
    withRunnerUpdateState(tx.home, (next) => {
      if (next.transaction?.id !== tx.id) throw new Error('runner update handoff changed before rollback');
      next.transaction.phase = 'rollback';
      next.transaction.failureReason = reason;
      next.transaction.rollbackResult = result;
    });
    restore(reason, result);
  }
  } finally { held.lock.release(); }
}
