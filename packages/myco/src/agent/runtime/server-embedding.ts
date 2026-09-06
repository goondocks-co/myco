import type { AgentTask } from '../types.js';
import type { ServerToolContext } from './server-tools.js';
import { postRunControl, postRunReport } from './run-store-http.js';

export const EMBEDDING_TASK = 'embedding-reconcile';
export const EMBEDDING_RUN_STEPS = 16;
const CLOSE_RESERVE_MS = 45_000;
export const embeddingTask: AgentTask = {
  name: EMBEDDING_TASK, displayName: 'Embedding reconciliation', description: 'Reconcile project memory vectors.',
  agent: 'myco-agent', prompt: '', isDefault: false, timeoutSeconds: 300,
};

/** The runtime drives bounded server operations and posts its report inside the run deadline. */
export async function executeEmbeddingRun(ctx: ServerToolContext, signal: AbortSignal, deadline: number): Promise<{ usage: { totalTokens: number } }> {
  let processed = 0;
  let phase = 'pending';
  for (let step = 0; step < EMBEDDING_RUN_STEPS && Date.now() + CLOSE_RESERVE_MS < deadline; step++) {
    signal.throwIfAborted();
    const result = await postRunControl(ctx.client, ctx.budget, '/runs/embedding-step', { runId: ctx.runId });
    if (result.held !== true) throw new Error('embedding run no longer holds its index');
    if (result.provider_unavailable === true) throw new Error('embedding provider is unavailable');
    if (typeof result.phase !== 'string' || typeof result.processed !== 'number') throw new Error('embedding step returned an invalid result');
    phase = result.phase;
    processed += result.processed;
    if (result.processed === 0) break;
  }
  signal.throwIfAborted();
  await postRunReport(ctx.client, ctx.budget, { runId: ctx.runId, agentId: ctx.agentId, action: 'embedding',
    summary: `Processed ${processed} embedding records; ${phase}.`, details: JSON.stringify({ processed, phase }) });
  return { usage: { totalTokens: 0 } };
}
