import { runControlClient } from '@goondocks/myco-shared/run-control';
import type { ServerEnv } from '../../core/adapters.js';
import { EMBEDDING_TASK } from '../../core/embedding/jobs.js';
import { executeEmbeddingRun } from '../../core/embedding/run.js';
import { classify, emit } from '../../telemetry.js';

/** The response deferral allows thirty seconds; work reserves its final five seconds for run closure. */
const HOSTED_RUN_BUDGET_MS = 25_000;
const CLOSE_RESERVE_MS = 5_000;

/** The invocation owns every launched promise until run closure has been attempted. */
export function cloudflareEmbeddingLaunch(
  origin: string,
  defer: (work: Promise<void>) => void,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): NonNullable<ServerEnv['harnessLaunch']> {
  return async (spec) => {
    if (spec.envVars.MYCO_TASK !== EMBEDDING_TASK) throw new Error('hosted embedding runtime does not serve this task');
    const budget = Math.min(HOSTED_RUN_BUDGET_MS, spec.timeoutSeconds * 1000);
    const request = runControlClient({ origin, token: spec.envVars.MYCO_MEMBER_TOKEN!, projectId: spec.envVars.MYCO_PROJECT! }, fetcher);
    defer(executeEmbeddingRun(spec, request, {
      deadline: Date.now() + budget, closeReserveMs: CLOSE_RESERVE_MS,
      signal: AbortSignal.timeout(Math.max(1, budget - CLOSE_RESERVE_MS)),
    }).catch((error: unknown) => {
      emit({ kind: 'embedding_run_failed', runId: spec.runId, error_class: classify(error) });
    }));
  };
}
