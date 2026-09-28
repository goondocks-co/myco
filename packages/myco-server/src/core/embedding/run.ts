import type { RunControl } from '@goondocks/myco-shared/run-control';
import type { ServerEnv } from '../adapters.js';
import { HARNESS_AGENT_ID } from '../harness.js';
import type { MissingSporeVectors } from './hubness.js';
import { VECTOR_REWRITE_LIMIT } from './provider.js';

export const EMBEDDING_RUN_STEPS = 16;
const CLOSE_RESERVE_MS = 45_000;
const CONTROL_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

/** What a run advanced, and the spores the last step found left out of calibration while the vector store does not return their vectors. */
export interface EmbeddingRunResult { processed: number; phase: string; missing?: MissingSporeVectors }

/** The left-out spores in the reader's words; nothing when there are none. */
function missingWords(missing: MissingSporeVectors | undefined): string[] {
  const said = (n: number, one: string, many: string) => `${n} spore${n === 1 ? ' is' : 's are'} left out of relevance calibration: ${n === 1 ? one : many}`;
  if (missing === undefined) return [];
  return [
    missing.rewriting > 0 ? said(missing.rewriting, 'the vector store has not returned its vector, so it is being written again.',
      'the vector store has not returned their vectors, so they are being written again.') : '',
    missing.waiting > 0 ? said(missing.waiting, 'its vector has been written again, and the vector store has not returned it yet.',
      'their vectors have been written again, and the vector store has not returned them yet.') : '',
    missing.abandoned > 0 ? said(missing.abandoned, `the vector store never returned its vector, even after it was written again ${VECTOR_REWRITE_LIMIT} times.`,
      `the vector store never returned their vectors, even after they were written again ${VECTOR_REWRITE_LIMIT} times.`) : '',
  ].filter((w) => w !== '');
}

export function embeddingRunReport(result: EmbeddingRunResult) {
  const summary = [`Processed ${result.processed} embedding records; ${result.phase}.`, ...missingWords(result.missing)].join(' ');
  return { action: 'embedding', summary, details: JSON.stringify(result) };
}

const isMissing = (value: unknown): value is MissingSporeVectors => value !== null && typeof value === 'object'
  && (['rewriting', 'waiting', 'abandoned'] as const).every((k) => Number.isInteger((value as MissingSporeVectors)[k]));

/** Advance bounded embedding steps while retaining time to close the run. */
export async function runEmbeddingSteps(step: () => Promise<Record<string, unknown>>, signal: AbortSignal, deadline: number, closeReserveMs = CLOSE_RESERVE_MS): Promise<EmbeddingRunResult> {
  let processed = 0;
  let phase = 'pending';
  let missing: MissingSporeVectors | undefined;
  for (let iteration = 0; iteration < EMBEDDING_RUN_STEPS && Date.now() + closeReserveMs < deadline; iteration++) {
    signal.throwIfAborted();
    if (iteration > 0 && Date.now() + closeReserveMs + CONTROL_TIMEOUT_MS >= deadline) break;
    const result = await step();
    if (result.held !== true) throw new Error('embedding run no longer holds its index');
    if (result.provider_unavailable === true) throw new Error('embedding provider is unavailable');
    if (typeof result.phase !== 'string' || typeof result.processed !== 'number') throw new Error('embedding step returned an invalid result');
    phase = result.phase;
    processed += result.processed;
    if (isMissing(result.missing)) missing = { rewriting: result.missing.rewriting, waiting: result.missing.waiting, abandoned: result.missing.abandoned };
    if (result.processed === 0) break;
  }
  signal.throwIfAborted();
  return missing === undefined || missing.rewriting + missing.waiting + missing.abandoned === 0 ? { processed, phase } : { processed, phase, missing };
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
