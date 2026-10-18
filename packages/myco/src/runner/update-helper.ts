/** Detached runner update handoff and authenticated-contact health rollback. */
import { isMemberHome } from '../member/home-role.js';
import path from 'node:path';
import { placeExecutable } from '../install/place-binary.js';
import { acquireInstallationLease, recoverInterruptedBinaryPublication, assertSourceAdoptionAllowed, publishAdoptedMarker, restoreInstallMarker, pendingBinaryPublication } from '../install/adoption.js';
import { versionBinaryPath } from '../install/managed-binary.js';
import { pruneVersions } from '../upgrade/apply-binary.js';
import { startService, statusOfService, stopService, type ServiceOutcome, type ServiceSpec } from '../server/service.js';
import { probeRunnerLocalCandidate, assertRunnerLocalCandidate, finishRunnerUpdate, runnerUpdateHealthReady, cleanupRunnerUpdateGuardian, readRunnerUpdateStateStrict as readRunnerUpdateState, runnerCurrentReleaseProbe, runnerUpdateStatePath, strictRunnerReleaseProbe, withRunnerUpdateState, type RunnerUpdateTransaction } from './update.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';

export const HELPER_INSTALLATION_WAIT_MS = 15_000;
const OLD_EXIT_WAIT_MS = 60_000;
const HEALTH_WAIT_MS = 90_000;
const POLL_MS = 500;

class AdoptionRefusal extends Error {}
class HealthRollback extends Error {}
class HandoffCanceled extends Error {}

export interface RunnerUpdateHelperDeps {
  log?: (line: string) => void;
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
  let installation: { release(): void } | undefined;
  const releaseInstallation = (): void => { installation?.release(); installation = undefined; };
  const holdInstallation = async (keepRetrying = false): Promise<boolean> => {
    if (installation) return true;
    let warned = false;
    for (let elapsed = 0; ; elapsed += POLL_MS) {
      const heldInstallation = acquireInstallationLease(home, { command: 'myco runner update helper installation' });
      if (heldInstallation.acquired) { installation = heldInstallation; return true; }
      if (elapsed >= HELPER_INSTALLATION_WAIT_MS && !warned) {
        const phase = readRunnerUpdateState(home).transaction?.phase;
        (deps.log ?? console.warn)(keepRetrying
          ? `Runner ${phase === 'rollback' || phase === 'placing' ? 'rollback' : 'recovery'} is waiting for another Myco setup or update to finish. This helper will keep retrying until installation access is available.`
          : 'Runner replacement has not started because another Myco setup or update is busy. The installed binary is unchanged; retry the update after it finishes.');
        if (!keepRetrying) return false;
        warned = true;
      }
      if (readRunnerUpdateState(home).transaction?.id !== tx?.id) throw new HandoffCanceled('runner update handoff was canceled');
      await wait(POLL_MS);
    }
  };
  try {
  const current = readRunnerUpdateState(home).transaction;
  if (current?.id !== tx?.id) throw new Error('Runner update handoff changed');
  const cleanup = (): void => {
    const heldCleanup = acquireInstallationLease(home, { command: 'myco runner update cleanup' });
    if (!heldCleanup.acquired) return;
    try { cleanupRunnerUpdateGuardian(home, tx?.platform ?? process.platform, deps); }
    finally { heldCleanup.release(); }
  };
  if (tx === undefined) { cleanup(); return; }
  if (current === undefined) throw new Error('Runner update handoff disappeared');
  const previousPublication = path.join(path.dirname(tx.binaryPath), tx.platform === 'win32' ? 'myco.prev.exe' : 'myco.prev');
  const pending = pendingBinaryPublication(tx.home, tx.binaryPath, previousPublication);
  if (['waiting', 'placing', 'rollback'].includes(current.phase) || pending !== null) {
    if (!await holdInstallation(pending !== null || current.phase !== 'waiting')) {
      if (stopped(tx.serviceSpec, tx.platform)) {
        const resumed = start(tx.serviceSpec, tx.platform);
        if (!resumed.running) throw new Error(resumed.detail ?? 'original runner service did not restart');
      }
      finishRunnerUpdate(tx, 'refused', 'Another Myco setup or update is busy; the installed binary was kept. Retry this update after it finishes.', now());
      cleanup();
      return;
    }
    recoverInterruptedBinaryPublication(tx.home, tx.binaryPath, tx.platform);
  }

  const target = tx.localCandidate?.binaryPath ?? versionBinaryPath(tx.home, tx.platform, tx.toVersion, tx.localAppData);
  const previous = versionBinaryPath(tx.home, tx.platform, tx.fromVersion, tx.localAppData);
  const placeRelease = (source: string, version: string, ready: typeof strictRunnerReleaseProbe, verifyState: () => void): void => place(source, tx.binaryPath, {
    platform: tx.platform,
    ready: file => {
      const result = tx.localCandidate && version === tx.toVersion
        ? probeRunnerLocalCandidate(tx.localCandidate, file, () => ready(file, version, tx.platform))
        : ready(file, version, tx.platform);
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
  const restore = async (reason: string, result: 'rolled_back' | 'failed'): Promise<void> => {
    if (!await holdInstallation(true)) return;
    stop(tx.serviceSpec, tx.platform);
    if (!stopped(tx.serviceSpec, tx.platform)) throw new Error('runner service did not stop for rollback');
    const ready = currentProbe(previous, tx.fromVersion, tx.platform);
    if (!ready.runs) throw new Error(`previous binary cannot run: ${ready.detail}`);
    withRunnerUpdateState(tx.home, next => {
      assertPhase(next.transaction, 'rollback');
      placeRelease(previous, tx.fromVersion, currentProbe, rollbackActive);
    });
    restoreInstallMarker(tx.home, tx.installMarker);
    const restored = start(tx.serviceSpec, tx.platform);
    if (!restored.running) throw new Error(restored.detail ?? 'restored runner service did not start');
    finishRunnerUpdate(tx, result, reason, now());
    releaseInstallation();
    cleanup();
  };
  if (current.phase === 'placing') {
    withRunnerUpdateState(tx.home, next => {
      if (next.transaction?.id !== tx.id) throw new Error('Runner update handoff changed');
      next.transaction.phase = 'rollback';
      next.transaction.failureReason = 'runner binary publication was interrupted';
      next.transaction.rollbackResult = 'failed';
    });
    await restore('runner binary publication was interrupted', 'failed');
    return;
  }
  if (current.phase === 'rollback') {
    await restore(current.failureReason ?? 'runner update is rolling back', current.rollbackResult ?? 'rolled_back');
    return;
  }
  let adopted = current.phase !== 'waiting';
  if (adopted) releaseInstallation();
  let finished = false;
  try {
    if (current.phase === 'waiting') {
      const started = now();
      while (alive(tx.ownerPid) && now() - started < OLD_EXIT_WAIT_MS) { active('waiting'); await wait(POLL_MS); }
      if (alive(tx.ownerPid)) throw new AdoptionRefusal('the previous runner did not exit');
      active('waiting');
      const live = currentProbe(tx.binaryPath, tx.fromVersion, tx.platform);
      if (!live.runs) throw new AdoptionRefusal('installed runner changed before handoff: ' + live.detail);
      try {
        if (tx.localCandidate) {
          assertSourceAdoptionAllowed(tx.home, tx.binaryPath);
          assertRunnerLocalCandidate(tx.localCandidate);
        }
      } catch (error) { throw new AdoptionRefusal(error instanceof Error ? error.message : String(error)); }
      const ready = probe(target, tx.toVersion, tx.platform);
      if (!ready.runs) throw new AdoptionRefusal(ready.detail);
      active('waiting');
      stop(tx.serviceSpec, tx.platform);
      if (!stopped(tx.serviceSpec, tx.platform)) throw new Error('runner service did not stop');
      active('waiting');
      withRunnerUpdateState(tx.home, next => {
        assertPhase(next.transaction, 'waiting');
        next.transaction!.phase = 'placing';
      });
      try {
        withRunnerUpdateState(tx.home, next => {
          assertPhase(next.transaction, 'placing');
          placeRelease(target, tx.toVersion, probe, () => active('placing'));
          next.transaction!.phase = 'adopted';
          adopted = true;
          publishAdoptedMarker(tx.home, tx.binaryPath, tx.toVersion, tx.localCandidate
            ? { kind: 'checkout', checkout: tx.localCandidate.checkout, commit: tx.localCandidate.commit }
            : { kind: 'release' }, tx.installMarker);
        });
      }
      catch (error) {
        if (error instanceof HandoffCanceled || error instanceof AdoptionRefusal) throw error;
        throw new AdoptionRefusal(error instanceof Error ? error.message : String(error));
      }
      releaseInstallation();
      if (tx.installMarker.source === 'checkout' && !tx.localCandidate) console.log('Replacing this source build with the selected channel release.');
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
      if (runnerUpdateHealthReady(observed, now())) {
        const refreshPending = isMemberHome(tx.home);
        console.log(refreshPending
          ? 'Agents refreshed: no (interactive refresh pending). Next: myco update or myco member provision --refresh'
          : 'Agents refreshed: no (this home is not a member machine).');
        finishRunnerUpdate(tx, 'updated', refreshPending ? 'agents_refresh_pending' : undefined, now());
        finished = true;
        cleanup();
        return;
      }
      if (observed.phase !== 'probation' && now() - healthStart >= HEALTH_WAIT_MS) throw new Error('updated runner did not make authenticated contact');
      releaseInstallation();
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
      finishRunnerUpdate(tx, error instanceof AdoptionRefusal ? 'refused' : 'failed', reason, now());
      finished = true;
      releaseInstallation();
      cleanup();
      return;
    }
    const result = error instanceof HealthRollback ? 'rolled_back' : 'failed';
    withRunnerUpdateState(tx.home, (next) => {
      if (next.transaction?.id !== tx.id) throw new Error('runner update handoff changed before rollback');
      next.transaction.phase = 'rollback';
      next.transaction.failureReason = reason;
      next.transaction.rollbackResult = result;
    });
    await restore(reason, result);
  }
  } finally { releaseInstallation(); }
  } finally { held.lock.release(); }
}
