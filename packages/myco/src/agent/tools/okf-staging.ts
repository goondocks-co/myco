/**
 * Per-run OKF synthesis staging registry.
 *
 * The `okf-synthesize` task's `synthesize` map phase and the executor's
 * `finalizeOkfSynthesize` success hook must share ONE open
 * {@link StagedGeneration} so every page appends to a single staging tree and
 * the whole run publishes atomically under ONE lock acquisition. They cannot
 * share it through a tool-factory closure: `createVaultTools` is rebuilt once
 * per phase (see phase-loop.ts), and the finalize hook lives in the executor,
 * not in any tool. This module is the bridge — a process-level map keyed by
 * `runId`.
 *
 * Lock lifetime (Task 1.5): a session holds the OKF lifecycle lock from
 * `beginStagedGeneration` until `finalize`/`abort`. The registry MUST always
 * finalize OR abort — never leak. The wiring guarantees that:
 *   - {@link openOkfSynthesisSession} opens lazily on the FIRST `okf_write_page`
 *     and is idempotent (one lock acquisition per run).
 *   - {@link finalizeOkfSynthesisSession} publishes on task success and always
 *     drops the entry (even if `finalize` throws — the session already released
 *     the lock in its own `finally`).
 *   - {@link abortOkfSynthesisSession} runs in the executor's failure cleanup
 *     and is a safe no-op when no session was ever opened (empty plan, or a
 *     failure before the first page write).
 */

import type { OkfBundle, StagedGeneration, OkfBundleWriteResult } from '@myco/okf/bundle.js';

interface OkfSynthesisSession {
  staged: StagedGeneration;
}

const SESSIONS = new Map<string, OkfSynthesisSession>();

/**
 * Open the run's staged generation ONCE, or return the already-open session.
 * Idempotent per `runId`: the first `okf_write_page` opens (and takes the
 * lock); every later page reuses the same staging tree. The `bundle` argument
 * is used only on the first call — subsequent bundles are discarded, so the
 * lock is acquired exactly once across the run.
 */
export async function openOkfSynthesisSession(runId: string, bundle: OkfBundle): Promise<StagedGeneration> {
  const existing = SESSIONS.get(runId);
  if (existing) return existing.staged;
  const staged = await bundle.beginStagedGeneration({ mode: 'published', generatedByRunId: runId });
  // A concurrent opener could have raced us while we awaited (map phases run
  // serially today, but guard anyway): if one landed, abort ours and reuse it
  // so only one lock is ever held per run.
  const raced = SESSIONS.get(runId);
  if (raced) {
    staged.abort();
    return raced.staged;
  }
  SESSIONS.set(runId, { staged });
  return staged;
}

/** True when a staged generation is currently open for this run. */
export function hasOkfSynthesisSession(runId: string): boolean {
  return SESSIONS.has(runId);
}

/**
 * Finalize (publish) the run's staged generation and drop it. Returns null when
 * no session was ever opened (empty plan or an all-skipped synthesize phase) —
 * nothing was staged, so there is nothing to publish and the prior bundle is
 * left untouched. The entry is always dropped, even if `finalize` throws.
 */
export async function finalizeOkfSynthesisSession(
  runId: string,
  opts?: Parameters<StagedGeneration['finalize']>[0],
): Promise<OkfBundleWriteResult | null> {
  const session = SESSIONS.get(runId);
  if (!session) return null;
  try {
    return await session.staged.finalize(opts);
  } finally {
    SESSIONS.delete(runId);
  }
}

/**
 * Abort the run's staged generation and drop it, releasing the lock without
 * touching the published bundle. Safe no-op when no session is open — the
 * executor's failure cleanup calls this unconditionally for okf-synthesize.
 */
export function abortOkfSynthesisSession(runId: string): void {
  const session = SESSIONS.get(runId);
  if (!session) return;
  try {
    session.staged.abort();
  } finally {
    SESSIONS.delete(runId);
  }
}
