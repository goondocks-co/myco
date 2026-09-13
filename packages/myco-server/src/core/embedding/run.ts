import type { RunControl } from '@goondocks/myco-shared/run-control';
import type { ServerEnv } from '../adapters.js';
import { HARNESS_AGENT_ID } from '../harness.js';

export const EMBEDDING_RUN_STEPS = 16;
const CLOSE_RESERVE_MS = 45_000;
const CONTROL_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

export function embeddingRunReport(result: { processed: number; phase: string }) {
  return { action: 'embedding', summary: `Processed ${result.processed} embedding records; ${result.phase}.`, details: JSON.stringify(result) };
}

/** Advance bounded embedding steps while retaining time to close the run. */
export async function runEmbeddingSteps(step: () => Promise<Record<string, unknown>>, signal: AbortSignal, deadline: number, closeReserveMs = CLOSE_RESERVE_MS): Promise<{ processed: number; phase: string }> {
  let processed = 0;
  let phase = 'pending';
  for (let iteration = 0; iteration < EMBEDDING_RUN_STEPS && Date.now() + closeReserveMs < deadline; iteration++) {
    signal.throwIfAborted();
    const result = await step();
    if (result.held !== true) throw new Error('embedding run no longer holds its index');
    if (result.provider_unavailable === true) throw new Error('embedding provider is unavailable');
    if (typeof result.phase !== 'string' || typeof result.processed !== 'number') throw new Error('embedding step returned an invalid result');
    phase = result.phase;
    processed += result.processed;
    if (result.processed === 0) break;
  }
  signal.throwIfAborted();
  return { processed, phase };
}

export type EmbeddingLaunch = Parameters<NonNullable<ServerEnv['harnessLaunch']>>[0];

/** Claim, advance, report and close one dispatched embedding run under its credential. */
export async function executeEmbeddingRun(
  spec: EmbeddingLaunch, request: RunControl,
  options: { signal: AbortSignal; deadline: number; closeReserveMs?: number },
): Promise<void> {
  const control = (path: string, payload: unknown) => request(path, payload,
    AbortSignal.any([options.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]));
  const close = async (status: 'completed' | 'failed', error?: string) => {
    const result = await request('/runs/update', {
      runId: spec.runId, update: { status, completed_at: Date.now(), tokens_used: 0, ...(error === undefined ? {} : { error }) },
    }, AbortSignal.timeout(CLOSE_TIMEOUT_MS));
    if (result.applied !== true) throw new Error(`embedding close refused: ${String(result.reason ?? 'not applied')}`);
  };
  try {
    const claimed = await control('/runs/claim', { id: spec.runId, agentId: HARNESS_AGENT_ID, task: spec.envVars.MYCO_TASK,
      captureDriven: true, startedAt: Date.now(), provider: 'embedding', model: spec.envVars.MYCO_MODEL });
    if (claimed.claimed !== true) throw new Error('embedding run claim refused');
    const result = await runEmbeddingSteps(() => control('/runs/embedding-step', { runId: spec.runId }),
      options.signal, options.deadline, options.closeReserveMs);
    await control('/runs/report', { runId: spec.runId, agentId: HARNESS_AGENT_ID, ...embeddingRunReport(result) });
    await close('completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await close('failed', message); }
    catch (closeError) { throw new AggregateError([error, closeError], 'embedding failed and its terminal update was not accepted'); }
    throw error;
  }
}
