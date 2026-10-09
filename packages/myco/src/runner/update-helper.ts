/** Detached runner update handoff and authenticated-contact health rollback. */
import path from 'node:path';
import semver from 'semver';
import { placeExecutable } from '../install/place-binary.js';
import { versionBinaryPath, writeInstallMarker } from '../install/managed-binary.js';
import { pruneVersions } from '../upgrade/apply-binary.js';
import { startService, statusOfService, stopService, type ServiceOutcome, type ServiceSpec } from '../server/service.js';
import { cleanupRunnerUpdateGuardian, readRunnerUpdateState, runnerUpdateStatePath, strictRunnerReleaseProbe, withRunnerUpdateState, type RunnerUpdateTransaction, type RunnerUpdateReceipt } from './update.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';

const OLD_EXIT_WAIT_MS = 60_000;
const HEALTH_WAIT_MS = 90_000;
const POLL_MS = 500;
const MAX_FAILED_VERSIONS = 20;

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
  return { ...(tx.requestId ? { requestId: tx.requestId } : {}), fromVersion: tx.fromVersion, toVersion: tx.toVersion,
    result, ...(reason ? { reason } : {}), at };
}

function finish(tx: RunnerUpdateTransaction, result: RunnerUpdateReceipt['result'], reason: string | undefined, at: number): void {
  withRunnerUpdateState(tx.home, (state) => {
    if (state.transaction?.id !== tx.id) throw new Error(`runner update ${tx.id} lost its transaction`);
    (state.lastResults ??= {})[tx.serverUrl] = receipt(tx, result, reason, at);
    if (result === 'rolled_back') state.failedVersions = [...new Set([tx.toVersion, ...(state.failedVersions ?? [])])].slice(0, MAX_FAILED_VERSIONS);
    if (result !== 'updated') state.cleanup = {
      failedVersion: tx.toVersion, currentVersion: tx.fromVersion, platform: tx.platform,
      ...(tx.localAppData ? { localAppData: tx.localAppData } : {}),
    };
    delete state.transaction;
  });
}
function pruneReason(tx: RunnerUpdateTransaction, current: string, previous: string | undefined, prune: typeof pruneVersions): string | undefined {
  try { prune(tx.home, tx.platform, 2, current, previous, tx.localAppData); return undefined; }
  catch (error) { return `version cleanup failed: ${String(error)}`; }
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
  const placeRelease = (source: string, version: string): void => place(source, tx.binaryPath, {
    platform: tx.platform, ready: file => probe(file, version, tx.platform),
  });
  const restore = (reason: string, result: 'rolled_back' | 'failed'): void => {
    stop(tx.serviceSpec, tx.platform);
    if (!stopped(tx.serviceSpec, tx.platform)) throw new Error('runner service did not stop for rollback');
    const ready = probe(previous, tx.fromVersion, tx.platform);
    if (!ready.runs) throw new Error(`previous binary cannot run: ${ready.detail}`);
    placeRelease(previous, tx.fromVersion);
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
      while (alive(tx.ownerPid) && now() - started < OLD_EXIT_WAIT_MS) await wait(POLL_MS);
      if (alive(tx.ownerPid)) {
        finish(tx, 'refused', 'the previous runner did not exit', now());
        finished = true;
        cleanupRunnerUpdateGuardian(tx.home, tx.platform, deps);
        return;
      }
      stop(tx.serviceSpec, tx.platform);
      if (!stopped(tx.serviceSpec, tx.platform)) throw new Error('runner service did not stop');
      const ready = probe(target, tx.toVersion, tx.platform);
      if (!ready.runs) throw new Error(ready.detail);
      placeRelease(target, tx.toVersion);
      adopted = true;
      withRunnerUpdateState(tx.home, (next) => {
        if (next.transaction?.id !== tx.id) throw new Error('runner update handoff changed');
        next.transaction.phase = 'adopted';
      });
      const startedService = start(tx.serviceSpec, tx.platform);
      if (!startedService.running) throw new Error(startedService.detail ?? 'runner service did not start');
    } else if (current.phase === 'adopted' && stopped(tx.serviceSpec, tx.platform)) {
      const restarted = start(tx.serviceSpec, tx.platform);
      if (!restarted.running) throw new Error(restarted.detail ?? 'updated runner service did not restart');
    }
    const healthStart = now();
    while (now() - healthStart < HEALTH_WAIT_MS) {
      const observed = readRunnerUpdateState(tx.home).transaction;
      if (observed?.id !== tx.id) throw new Error('runner update handoff changed during health watch');
      if (observed.phase === 'healthy') {
        writeInstallMarker(tx.home, { ...tx.installMarker, bin: tx.binaryPath, prerelease: semver.prerelease(tx.toVersion) !== null });
        const cleanupError = pruneReason(tx, tx.toVersion, tx.fromVersion, deps.prune ?? pruneVersions);
        finish(tx, 'updated', cleanupError, now());
        finished = true;
        cleanupRunnerUpdateGuardian(tx.home, tx.platform, deps);
        return;
      }
      await wait(POLL_MS);
    }
    throw new Error('updated runner did not make authenticated contact');
  } catch (error) {
    if (finished) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    withRunnerUpdateState(tx.home, (next) => {
      if (next.transaction?.id !== tx.id) throw new Error('runner update handoff changed before rollback');
      next.transaction.phase = 'rollback';
      next.transaction.failureReason = reason;
      next.transaction.rollbackResult = adopted ? 'rolled_back' : 'failed';
    });
    restore(reason, adopted ? 'rolled_back' : 'failed');
  }
  } finally { held.lock.release(); }
}
