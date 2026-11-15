
import type { RelationalStore } from '../../core/adapters.js';
import type { TitleSnapshot } from '../documents/titling-material.js';
import { DIRECT_TITLE_BUDGET_MS, DIRECT_TITLE_SETTLEMENT_MS, completionAccounting, DIRECT_CALL_WINDOW_MS, DIRECT_CALLS_PER_MINUTE, COMPLETION_TIMEOUT_MS, COMPLETION_ATTEMPTS } from '../../core/completion/provider.js';
import { commit, rows, write } from '../index.js';
import { storeSessionTitle, uncalledTitleRelease } from '../session-titles.js';
import { ensureAgentWrite } from './claim.js';


const AGENT = 'myco-agent';
const insert = write<[project: string, run: string, model: string, now: number, context: string, origin: string, accounting: string, dispatch: string], { id: string }>({
  name: 'directTitle.begin', sql: `INSERT INTO agent_runs(project_id,id,agent_id,task,provider,model,status,started_at,run_context,origin,usage_data,dispatch_spec,attempt_counted)
    SELECT ?1,?2,'${AGENT}','title-summary','direct',?3,'running',?4,?5,?6,?7,?8,CASE WHEN json_extract(?5,'$.mode')='claim' THEN 1 ELSE 0 END
    RETURNING id`,
});

const countAttempt = write<[project: string, session: string, run: string], never>({ name: 'directTitle.countAttempt', sql: `
  UPDATE sessions SET titling_attempts=titling_attempts+1 WHERE project_id=?1 AND session_id=?2
    AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?1 AND id=?3 AND provider='direct' AND status='running' AND attempt_counted=1)` });

/** Records direct work without a runner attempt, lease or harness credential. */
export async function beginDirectTitle(db: RelationalStore, ask: { project: string; run: string; model: string; now: number; session: string; mode: string; by?: string }) {
  const { project, run, model, now, session, mode, by } = ask;
  const result = await commit(db, ensureAgentWrite(db, { id: AGENT, name: AGENT, provider: null, model: null, enabled: true }, now),
    insert.bind(project, run, model, now, JSON.stringify({ session_id: session, mode, execution: 'direct', timeoutSeconds: (DIRECT_TITLE_BUDGET_MS + DIRECT_TITLE_SETTLEMENT_MS) / 1000, actor: by ?? 'deployment' }), mode === 'owner' ? 'manual' : 'automatic', completionAccounting(model, null), JSON.stringify({ actor: by ?? 'deployment', execution: 'direct' })), countAttempt.bind(project, session, run));
  return result[1]!.results.length > 0;
}

const finish = write<[project: string, run: string, now: number, tokens: number | null, cost: number | null, usage: string | null, error: string | null, partial: number], { id: string }>({
  name: 'directTitle.finish', sql: `UPDATE agent_runs SET status=CASE WHEN ?7 IS NULL THEN 'completed' ELSE 'failed' END,
    error_code=?7,completed_at=?3,tokens_used=?4,cost_usd=?5,estimated_cost_usd=?5,cost_source=CASE WHEN ?8=1 THEN 'partial' WHEN ?5 IS NULL THEN 'unknown' ELSE 'catalogue_estimate' END,
    usage_data=?6,error=?7,actions_taken=CASE WHEN ?7 IS NULL THEN '[{"action":"session_titled","summary":"Wrote the session title and summary"}]' ELSE NULL END
    WHERE project_id=?1 AND id=?2 AND provider='direct' AND status='running' RETURNING id`,
});
export interface DirectTitleSettlement { project: string; run: string; now: number; tokens: number | null; cost: number | null; usage: string | null; partial: boolean }
const settlement = (s: DirectTitleSettlement, error: string | null) => finish.bind(s.project, s.run, s.now, s.tokens, s.cost, s.usage, error, s.partial ? 1 : 0);

/** Title, observed coverage, write attribution and terminal record land together or leave the claim intact. */
export async function completeDirectTitle(db: RelationalStore, s: DirectTitleSettlement, answer: {
  session: string; stamp: number; title: string; summary: string; by: string | null; snapshot: TitleSnapshot; mode: string;
}): Promise<boolean> {
  return storeSessionTitle(db, {
    projectId: s.project, sessionId: answer.session, title: answer.title, summary: answer.summary,
    mode: answer.mode === 'claim' ? 'first' : 'overwrite', by: answer.by,
    observed: { ...answer.snapshot, runId: s.run, stamp: answer.stamp },
    attribution: { runId: s.run, toolName: 'myco_run_sessions', op: 'title', recordedAt: s.now, detail: { session_id: answer.session, execution: 'direct' } },
    after: [settlement(s, null)],
  });
}

/** A named failure leaves the session's prior title and coverage intact. */
export async function failDirectTitle(db: RelationalStore, s: DirectTitleSettlement, failure: {
  code: string; session: string; stamp: number; previous: number | null; mode: string;
}): Promise<void> {
  await commit(db, ...uncalledTitleRelease({ project: s.project, run: s.run, session: failure.session, stamp: failure.stamp,
    previous: failure.previous, mode: failure.mode, now: s.now }), settlement(s, failure.code));
}


const CALL_START_WINDOW_MS = COMPLETION_TIMEOUT_MS * COMPLETION_ATTEMPTS;
const reserveCall = write<[project: string, run: string, now: number], { id: number }>({
  name: 'directTitle.reserveCall', sql: `INSERT INTO agent_run_events(project_id,run_id,event_type,recorded_at)
    SELECT ?1,?2,'direct_call',?3
    WHERE EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?1 AND id=?2 AND provider='direct' AND status='running' AND started_at>?3-${CALL_START_WINDOW_MS})
    AND (SELECT COUNT(*) FROM agent_runs r INDEXED BY idx_agent_runs_task_started
      CROSS JOIN agent_run_events e ON e.project_id=r.project_id AND e.run_id=r.id
      WHERE r.task='title-summary' AND r.provider='direct' AND r.started_at>?3-${DIRECT_CALL_WINDOW_MS + CALL_START_WINDOW_MS}
        AND e.event_type='direct_call' AND e.recorded_at>?3-${DIRECT_CALL_WINDOW_MS})<${DIRECT_CALLS_PER_MINUTE}
    RETURNING id`,
});

/** A provider request reserves its own slot in the same atomic write that counts the trailing minute. */
export async function reserveDirectCall(db: RelationalStore, project: string, run: string, now: number): Promise<boolean> {
  return (await rows(db, reserveCall.bind(project, run, now))).length > 0;
}
