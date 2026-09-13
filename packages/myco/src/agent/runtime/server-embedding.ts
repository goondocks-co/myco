import { embeddingRunReport, runEmbeddingSteps } from '@myco-server-worker/core/embedding/run.js';
import type { AgentTask } from '../types.js';
import type { ServerToolContext } from './server-tools.js';
import { postRunControl, postRunReport } from './run-store-http.js';

export const EMBEDDING_TASK = 'embedding-reconcile';
export { EMBEDDING_RUN_STEPS } from '@myco-server-worker/core/embedding/run.js';
export const embeddingTask: AgentTask = {
  name: EMBEDDING_TASK, displayName: 'Embedding reconciliation', description: 'Reconcile project memory vectors.',
  agent: 'myco-agent', prompt: '', isDefault: false, timeoutSeconds: 300,
};

/** The runtime drives bounded server operations and posts its report inside the run deadline. */
export async function executeEmbeddingRun(ctx: ServerToolContext, signal: AbortSignal, deadline: number): Promise<{ usage: { totalTokens: number } }> {
  const { processed, phase } = await runEmbeddingSteps(
    () => postRunControl(ctx.client, ctx.budget, '/runs/embedding-step', { runId: ctx.runId }), signal, deadline);
  signal.throwIfAborted();
  await postRunReport(ctx.client, ctx.budget, { runId: ctx.runId, agentId: ctx.agentId, ...embeddingRunReport({ processed, phase }) });
  return { usage: { totalTokens: 0 } };
}
