/**
 * `myco_sessions` over the Deployment's session facts.
 *
 * The shape is the member-side tool's: a summary per session with the field
 * names skills key on. `title` and `summary` are the Deployment's own
 * titling write, made after the session ends; they answer null and empty
 * until it lands. Timestamps are the Deployment's, in milliseconds.
 */
import { getPlan } from '../../read/plans.js';
import { getSession, listSessionSummaries, sessionCounts, type SessionRow } from '../../read/sessions.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export const DEFAULT_LIMIT = 20;

interface SessionSummary {
  id: string;
  agent: string | null;
  user: string | null;
  branch: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: 'active' | 'completed';
  title: string | null;
  summary: string;
  prompt_count: number;
  tool_count: number;
  parent_session_id: string | null;
}

function summary(row: SessionRow, counts: { prompts: number; toolCalls: number }): SessionSummary {
  return {
    id: row.sessionId,
    agent: row.agent,
    user: row.memberLabel,
    branch: row.branch,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    status: row.endedAt === null ? 'active' : 'completed',
    title: row.title,
    summary: row.summary ?? '',
    prompt_count: counts.prompts,
    tool_count: counts.toolCalls,
    parent_session_id: row.parentSessionId,
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export async function handleSessions(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  const op = input.op ?? 'list';

  if (op === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const row = await getSession(db, scope, id);
    if (row === null) return failure('Session not found');
    const counts = await sessionCounts(db, scope, id);
    return { ...summary(row, counts), counts };
  }

  let sessionId = str(input.session);
  const plan = str(input.plan);
  if (plan !== undefined) {
    const row = await getPlan(db, scope, plan);
    if (row === null) return [];
    sessionId = row.sessionId;
  }
  const since = str(input.since);
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  const status = str(input.status);
  const state = status === 'active' ? 'open' : status === 'completed' ? 'ended' : undefined;
  if (status !== undefined && state === undefined) return failure('status must be active or completed');

  const page = await listSessionSummaries(db, scope, {
    limit: typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
    branch: str(input.branch),
    since: sinceMs === undefined || Number.isNaN(sinceMs) ? undefined : sinceMs,
    state,
    memberLabel: str(input.user),
    sessionId,
  }, ctx.now);
  return page.rows.map((row) => summary(row, { prompts: row.promptCount, toolCalls: row.toolCallCount }));
}
