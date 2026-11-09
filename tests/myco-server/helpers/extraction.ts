import { buildLearningAssignment, completeLearning, type LearningAssignment } from '@myco-server-worker/core/learning-sessions.js';
import { recordServedPrompts } from '@myco-server-worker/db/runs/served.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { ensureAgent } from '@myco-server-worker/db/runs/state.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

type Prompt = Parameters<typeof recordServedPrompts>[3][number];

/** Seed card-model output and serve its prompts through the production ledger. */
export async function prepareLearningSlice(db: RelationalStore, scope: ReadScope, runId: string, sessionId: string,
  prompts: readonly Prompt[], now: number): Promise<LearningAssignment> {
  await db.prepare(`INSERT OR IGNORE INTO learning_sessions(project_id,session_id,init_state) VALUES(?,?,'ready')`)
    .bind(scope.projectId, sessionId).run();
  await db.batch(prompts.map(prompt => db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,input_hash,card,signal,records,last_seq,created_at,carded_at)
    VALUES(?,?,?,'carded',?,'fixture card','high',?,1,?,?)
    ON CONFLICT(project_id,session_id,turn_key) DO UPDATE SET state='carded',input_hash=excluded.input_hash,records=excluded.records,covered=0`)
    .bind(scope.projectId, sessionId, prompt.promptId, `${runId}:${prompt.promptId}`, JSON.stringify([['prompt', prompt.promptId]]), prompt.createdAt, now)));
  await recordServedPrompts(db, scope, runId, prompts, now);
  const assignment = (await buildLearningAssignment(db, scope.projectId, sessionId))!;
  return { ...assignment, turns: prompts.map(prompt => ({ turnKey: prompt.promptId, inputHash: `${runId}:${prompt.promptId}` })) };
}

/** Prepare a fixture slice whose completion can be delayed until after another write. */
export async function preparePromptAcknowledgement(db: RelationalStore, scope: ReadScope, promptId: string): Promise<() => Promise<boolean>> {
  const now = Date.now();
  const runId = crypto.randomUUID();
  await ensureAgent(db, { id: 'coverage-agent', name: 'Coverage', provider: null, model: null, enabled: true }, now);
  await recordDispatch(db, scope, { id: runId, agentId: 'coverage-agent', task: 'extract-curate', provider: null,
    model: null, runContext: null, dispatchedBy: null, startedAt: now });
  const row = await db.prepare('SELECT session_id AS sessionId, created_at AS createdAt FROM session_prompts WHERE project_id = ? AND prompt_id = ?')
    .bind(scope.projectId, promptId).first<{ sessionId: string; createdAt: number }>();
  if (row === null) return async () => false;
  const assignment = await prepareLearningSlice(db, scope, runId, row.sessionId, [{ ...row, promptId, endedAt: null }], now);
  return async () => (await completeLearning(db, scope.projectId, row.sessionId, runId, assignment, '', now)).completed;
}

export async function markPromptProcessed(db: RelationalStore, scope: ReadScope, promptId: string): Promise<boolean> {
  return (await preparePromptAcknowledgement(db, scope, promptId))();
}
