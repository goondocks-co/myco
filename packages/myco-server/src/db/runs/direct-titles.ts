
import type { RelationalStore } from '../../core/adapters.js';
import type { TitleSnapshot } from '../documents/titling-material.js';
import { completionAccounting, DIRECT_CALLS_PER_MINUTE, COMPLETION_TIMEOUT_MS } from '../../core/completion/provider.js';
import { commit, rows, write } from '../index.js';
import { attributedUpdate, commitAttributedWrite } from './attribution.js';
import { ensureAgentWrite } from './claim.js';
import { notTombstonedSql } from '../session-read-model.js';

const AGENT = 'myco-agent';
const insert = write<[project: string, run: string, model: string, now: number, context: string, origin: string, accounting: string], { id: string }>({
  name: 'directTitle.begin', sql: `INSERT INTO agent_runs(project_id,id,agent_id,task,provider,model,status,started_at,run_context,origin,usage_data)
    SELECT ?1,?2,'${AGENT}','title-summary','direct',?3,'running',?4,?5,?6,?7
    RETURNING id`,
});

/** Records direct work without a runner attempt, lease or harness credential. */
export async function beginDirectTitle(db: RelationalStore, ask: { project: string; run: string; model: string; now: number; session: string; mode: string; by?: string }) {
  const { project, run, model, now, session, mode, by } = ask;
  const result = await commit(db, ensureAgentWrite(db, { id: AGENT, name: AGENT, provider: null, model: null, enabled: true }, now),
    insert.bind(project, run, model, now, JSON.stringify({ session_id: session, mode, execution: 'direct', actor: by ?? 'deployment' }), mode === 'owner' ? 'manual' : 'automatic', completionAccounting(model, null)));
  return result.at(-1)!.results.length > 0;
}

const title = attributedUpdate<[project: string, session: string, run: string, stamp: number, title: string, summary: string, by: string | null, material: number, generation: number, mode: string]>(
  'directTitle.write', 'sessions', 'title=?5,summary=?6,titled_by=?7,title_material_at=?8',
  `project_id=?1 AND session_id=?2 AND titled_at=?4 AND ${notTombstonedSql('sessions')}
    AND (?10<>'claim' OR title IS NULL) AND EXISTS(SELECT 1 FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2 AND d.generation=?9 AND d.state='live')\n    AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=?1 AND r.id=?3 AND r.provider='direct' AND r.status='running')`,
  'session_id', 'project_id=?1 AND session_id=?2 AND title=?5 AND summary=?6 AND title_material_at=?8');
const coverage = write<[project: string, session: string, generation: number, prompts: number], never>({ name: 'directTitle.coverage',
  sql: `UPDATE session_documents SET titled_user_prompts=MAX(COALESCE(titled_user_prompts,0),MIN(user_prompts,?4))
    WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live'` });
const finish = write<[project: string, run: string, now: number, tokens: number | null, cost: number | null, usage: string | null, error: string | null], { id: string }>({
  name: 'directTitle.finish', sql: `UPDATE agent_runs SET status=CASE WHEN ?7 IS NULL THEN 'completed' ELSE 'failed' END,
    error_code=?7,completed_at=?3,tokens_used=?4,cost_usd=?5,estimated_cost_usd=?5,cost_source=CASE WHEN ?5 IS NULL THEN 'unknown' ELSE 'catalogue_estimate' END,
    usage_data=?6,error=?7,actions_taken=CASE WHEN ?7 IS NULL THEN '[{"action":"session_titled","summary":"Wrote the session title and summary"}]' ELSE NULL END
    WHERE project_id=?1 AND id=?2 AND provider='direct' AND status='running' RETURNING id`,
});
export interface DirectTitleSettlement { project: string; run: string; now: number; tokens: number | null; cost: number | null; usage: string | null }
const settlement = (s: DirectTitleSettlement, error: string | null) => finish.bind(s.project, s.run, s.now, s.tokens, s.cost, s.usage, error);

/** Title, observed coverage, write attribution and terminal record land together or leave the claim intact. */
export async function completeDirectTitle(db: RelationalStore, s: DirectTitleSettlement, answer: {
  session: string; stamp: number; title: string; summary: string; by: string | null; snapshot: TitleSnapshot; mode: string;
}): Promise<boolean> {
  const result = await commitAttributedWrite(db, { projectId: s.project },
    title.bind(s.project, answer.session, s.run, answer.stamp, answer.title, answer.summary, answer.by, answer.snapshot.materialAt, answer.snapshot.generation, answer.mode),
    { runId: s.run, toolName: 'myco_run_sessions', op: 'title', recordedAt: s.now, detail: { session_id: answer.session, execution: 'direct' } },
    [coverage.bind(s.project, answer.session, answer.snapshot.generation, answer.snapshot.userPrompts), settlement(s, null)]);
  return result.results.length > 0;
}

/** A named failure leaves the session's prior title and coverage intact. */
export async function failDirectTitle(db: RelationalStore, s: DirectTitleSettlement, code: string): Promise<void> {
  await rows(db, settlement(s, code));
}


const reserveCall = write<[project: string, run: string, now: number], { id: number }>({
  name: 'directTitle.reserveCall', sql: `INSERT INTO agent_run_events(project_id,run_id,event_type,recorded_at)
    SELECT ?1,?2,'direct_call',?3
    WHERE EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?1 AND id=?2 AND provider='direct' AND status='running' AND started_at>?3-${2 * COMPLETION_TIMEOUT_MS})
    AND (SELECT COUNT(*) FROM agent_runs r INDEXED BY idx_agent_runs_task_started
      CROSS JOIN agent_run_events e ON e.project_id=r.project_id AND e.run_id=r.id
      WHERE r.task='title-summary' AND r.provider='direct' AND r.started_at>?3-${4 * COMPLETION_TIMEOUT_MS}
        AND e.event_type='direct_call' AND e.recorded_at>?3-60000)<${DIRECT_CALLS_PER_MINUTE}
    RETURNING id`,
});

/** A provider request reserves its own slot in the same atomic write that counts the trailing minute. */
export async function reserveDirectCall(db: RelationalStore, project: string, run: string, now: number): Promise<boolean> {
  return (await rows(db, reserveCall.bind(project, run, now))).length > 0;
}
