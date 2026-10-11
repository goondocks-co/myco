import { projectDiagnostics } from '@myco/member/diagnostics.js';
import { MemberSpool } from '@myco/member/spool.js';
import type { RegistryEntry } from '@myco/member/registry.js';
import { workerServiceStatus } from '@myco/runner/service.js';
import { platformRunner } from '@myco/server/service.js';
import { executorServiceTarget, type WorkerServiceDeps } from '@myco/cli/worker-service.js';

export const RECENT_REFUSAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Capture facts under existing locks and refusal dates across the full log. */
export function observeProjectCapture(entry: RegistryEntry, home: string, now: number) {
  const facts = projectDiagnostics(entry, home, now, { createReadLocks: false });
  const refusals = new MemberSpool(entry, { mycoHome: home, initialize: false, createReadLocks: false }).readRefused();
  return {
    ...facts,
    refusalHistory: {
      readable: refusals.readable,
      total: refusals.entries.length,
      latest: refusals.entries.reduce<number | null>((last, refusal) => last === null ? refusal.at : Math.max(last, refusal.at), null),
      recent: refusals.entries.filter(refusal => refusal.at >= now - RECENT_REFUSAL_MS).length,
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
