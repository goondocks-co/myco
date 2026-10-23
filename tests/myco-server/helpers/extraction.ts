import { acknowledgePrompt } from '@myco-server-worker/core/extraction-acks.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { recordDispatch, ensureAgent } from '@myco-server-worker/core/runs.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

/** Serve a held prompt and acknowledge it through the run's production writer. */
export async function preparePromptAcknowledgement(db: RelationalStore, scope: ReadScope, promptId: string): Promise<() => Promise<boolean>> {
  const now = Date.now();
  const runId = crypto.randomUUID();
  await ensureAgent(db, { id: 'coverage-agent', name: 'Coverage', provider: null, model: null, enabled: true }, now);
  await recordDispatch(db, scope, { id: runId, agentId: 'coverage-agent', task: 'extract-curate', provider: null,
    model: null, runContext: null, dispatchedBy: null, startedAt: now });
  const row = await db.prepare('SELECT session_id AS sessionId, created_at AS createdAt FROM prompt_batches WHERE project_id = ? AND prompt_id = ?')
    .bind(scope.projectId, promptId).first<{ sessionId: string; createdAt: number }>();
  if (row === null) return async () => false;
  const [item] = await recordServedPrompts(db, scope, runId, [{ ...row, promptId, endedAt: null }], now);
  return async () => {
    const result = await acknowledgePrompt(db, scope, runId, { servedId: item!.servedId }, now);
    return 'marked' in result && result.marked;
  };
}

export async function markPromptProcessed(db: RelationalStore, scope: ReadScope, promptId: string): Promise<boolean> {
  return (await preparePromptAcknowledgement(db, scope, promptId))();
}
