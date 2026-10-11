import { projectDiagnostics } from '@myco/member/diagnostics.js';
import type { RegistryEntry } from '@myco/member/registry.js';
import { workerServiceStatus } from '@myco/runner/service.js';
import { platformRunner } from '@myco/server/service.js';
import { executorServiceTarget, type WorkerServiceDeps } from '@myco/cli/worker-service.js';

export const observationInstant = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) ? new Date(ms).toISOString() : 'unknown');

export { RECENT_REFUSAL_MS } from '@myco/member/diagnostics.js';

/** Capture facts under existing locks and refusal dates across the full log. */
export function observeProjectCapture(entry: RegistryEntry, home: string, now: number) {
  const facts = projectDiagnostics(entry, home, now, { createReadLocks: false });
  const refusals = facts.refusals;
  return {
    ...facts,
    refusalHistory: {
      readable: refusals.logReadable,
      total: refusals.loggedSinceLastReset,
      latest: refusals.latestAt,
      recent: refusals.recentCount,
      unreadableLines: refusals.unreadableLines,
    },
  };
}

/** Service-manager queries and the existing process lock establish runtime state. */
export function observeRunnerService(serverUrl: string, worker: WorkerServiceDeps) {
  let unavailable = false;
  const state = workerServiceStatus(executorServiceTarget(serverUrl, worker, 'runner'), {
    runner: (command, args) => {
      const result = (worker.runner ?? platformRunner)(command, args);
      unavailable ||= result.error !== undefined;
      return result;
    },
    lockDir: worker.lockDir,
  });
  return {
    state,
    unavailable,
    words: !state.installed ? 'not installed' : !state.loaded ? 'installed, not loaded' : !state.running ? 'installed, stopped' : 'running',
  };
}
