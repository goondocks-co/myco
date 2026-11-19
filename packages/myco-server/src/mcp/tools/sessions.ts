import { TurnLocatorBuilding } from '../../db/documents/locators.js';
/**
 * `myco_sessions` over the Deployment's session facts.
 *
 * The shape is the member-side tool's: a summary per session with the field
 * names skills key on. `title` and `summary` are written by a titling run
 * the Deployment dispatches after the session ends; they answer null and
 * empty until it lands. Timestamps are the Deployment's, in milliseconds.
 */
import { documentTurnCollection, documentTurnDetail, TURN_COLLECTIONS, type TurnCollection } from '../../content/session-turns.js';
import { listCatalogTurns } from '../../read/document-catalog.js';
import { decodeCursor } from '../../read/scope.js';
import { PROMPT_ORIGINS } from '../../ingest/kinds.js';
import { getReleaseStatus } from '../../core/provenance.js';
import { sessionQuietBefore } from '../../core/session-quiet.js';
import { plans_getPlan as getPlan } from '../../read/catalog/plans.js';
import {
  sessions_getSession as getSession,
  sessions_listSessionSummaries as listSessionSummaries,
  sessions_sessionCounts as sessionCounts,
  type sessions_SessionRow as SessionRow,
} from '../../read/catalog/sessions.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const DEFAULT_LIMIT = 20;

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
  launch_parent_session_id: string | null;
}

function summary(row: SessionRow, counts: { prompts: number; toolCalls: number }): SessionSummary {
  return {
    id: row.sessionId,
    agent: row.agent,
    user: row.memberLabel,
    branch: row.branch,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    status: row.live ? 'active' : 'completed',
    title: row.title,
    summary: row.summary ?? '',
    prompt_count: counts.prompts,
    tool_count: counts.toolCalls,
    parent_session_id: row.parentSessionId,
    launch_parent_session_id: row.launchParentSessionId,
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

async function sessions(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  const op = input.op ?? 'list';
  if (ctx.principal.kind === 'grant' && (input.prompt_id !== undefined || input.collection !== undefined)) {
    const id = str(input.id);
    const next = id === undefined ? { op: 'list' } : { op: 'get', id };
    return failure(`Not read: conversation turns; grant keys may read session summaries only. Next call: myco_sessions ${JSON.stringify(next)} without prompt_id or collection.`);
  }

  if (op === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const row = await getSession(db, scope, id, ctx.now, await sessionQuietBefore(ctx.env, ctx.now));
    if (row === null) return failure('Session not found');
    const promptId = str(input.prompt_id);
    if (promptId === undefined && str(input.collection) !== undefined) return failure('collection requires prompt_id; call myco_sessions with op get and id to list its turns first.');
    const cursor = str(input.cursor);
    if (promptId !== undefined) {
      const collection = str(input.collection);
      if (collection !== undefined) {
        if (!(TURN_COLLECTIONS as readonly string[]).includes(collection)) return failure('Unknown collection; call myco_sessions with op get, id and prompt_id, then use a collection named in cursors.');
        const page = await documentTurnCollection(ctx.env, scope, id, promptId, collection as TurnCollection, cursor);
        if (page === 'stale') return failure('stale_cursor: the conversation changed; call myco_sessions with op get, id and prompt_id without cursor.');
        return page ?? failure('Turn or cursor not found; call myco_sessions with op get and id to list its turns.');
      }
      if (cursor !== undefined) return failure('A turn cursor requires collection; call myco_sessions with op get, id, prompt_id, collection and the matching cursor.');
      return await documentTurnDetail(ctx.env, scope, id, promptId) ?? failure('Turn not found; call myco_sessions with op get and id to list its turns.');
    }
    if (cursor !== undefined && decodeCursor(cursor) === null) return failure('Invalid cursor; call myco_sessions with op get and id without cursor to list its turns.');
    const turns = ctx.principal.kind === 'grant' ? undefined : await listCatalogTurns(db, scope, id, {
      origins: PROMPT_ORIGINS, limit: typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT, cursor,
    });
    const counts = await sessionCounts(db, scope, id);
    return { ...summary(row, counts), counts, ...(turns === undefined ? {} : { turns }), release: await getReleaseStatus(db, scope, 'session', id) };
  }

  let sessionId: string | undefined;
  const plan = str(input.plan);
  if (plan !== undefined) {
    const row = await getPlan(db, scope, plan);
    if (row === null) return { sessions: [], cursor: null };
    sessionId = row.sessionId;
  }
  const since = str(input.since);
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  const status = str(input.status);
  const state = status === 'active' ? 'open' : status === 'completed' ? 'ended' : undefined;
  if (status !== undefined && state === undefined) return failure('status must be active or completed');

  const cursor = str(input.cursor);
  if (cursor !== undefined && decodeCursor(cursor) === null) return failure('Invalid cursor; call myco_sessions with op list and no cursor to start again.');
  const page = await listSessionSummaries(db, scope, {
    limit: typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
    cursor,
    branch: str(input.branch),
    since: sinceMs === undefined || Number.isNaN(sinceMs) ? undefined : sinceMs,
    state,
    memberLabel: str(input.user),
    sessionId,
    quietBefore: await sessionQuietBefore(ctx.env, ctx.now),
  }, ctx.now);
  return { sessions: page.rows.map((row) => summary(row, { prompts: row.promptCount, toolCalls: row.toolCallCount })), cursor: page.cursor };
}

/** Turn locator repair is a named, retryable read refusal on MCP. */
export async function handleSessions(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  try { return await sessions(input, ctx); }
  catch (error) {
    if (error instanceof TurnLocatorBuilding) return { ok: false, error: 'turn_locator_building', retryable: true, message: error.message };
    throw error;
  }
}
