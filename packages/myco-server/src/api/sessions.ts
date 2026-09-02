import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { getSession, listSessionSummaries, projectStats, sessionCounts, type SessionFilters } from '../read/sessions.js';
import { activityFeed } from '../read/activity.js';
import { badRequest, notFound, ok, resolveProjectScope, sessionInScope } from './scope.js';
import { decodeCursor } from '../read/scope.js';
import { listAttachments, listPlans, listPrompts, listResponses, listToolCalls } from '../read/children.js';
import { listTurns, parseOrigins, promptInSession, turnDetail } from '../read/turns.js';
import { getTranscript, listSegments } from '../read/transcript.js';
import { titleSession } from '../core/titling.js';
import { changePlanStatus } from '../core/plans.js';
import { PLAN_STATUS_MESSAGE, planInSession, WRITABLE_PLAN_STATUSES } from '../read/plans.js';

/** The five child collections, by URL segment. One handler serves all of them: they differ only in which query runs. */
const CHILDREN = {
  prompts: listPrompts,
  'tool-calls': listToolCalls,
  responses: listResponses,
  plans: listPlans,
  attachments: listAttachments,
} as const;

export const CHILD_SEGMENTS = Object.keys(CHILDREN);

/**
 * The session id a path segment names. Ingest admits any non-empty string within
 * `MAX_ID_CHARS` (`ingest/envelope.ts:95-98`), so an id reaches storage carrying spaces,
 * `+`, `~`, `#` or non-ASCII, and a route grammar narrower than that lists such a session
 * and then never opens it. The segment arrives percent-encoded; a malformed escape names
 * no session.
 */
export function sessionIdParam(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.length > 0 && decoded.length <= 128 ? decoded : null;
}

/** The caller's paging arguments, or a refusal. A malformed cursor is refused rather than ignored: silently serving page one to a client that asked for page nine loses rows without saying so. */
export function paging(url: URL): { limit?: number; cursor?: string } | Response {
  const rawLimit = url.searchParams.get('limit');
  const rawCursor = url.searchParams.get('cursor');
  if (rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) return badRequest('limit must be a positive integer');
  if (rawCursor !== null && decodeCursor(rawCursor) === null) return badRequest('malformed cursor');
  return { limit: rawLimit === null ? undefined : Number(rawLimit), cursor: rawCursor ?? undefined };
}

/** The list's filters as the query names them: `state`, `branch`, `member`, `q`. An unknown state is refused. */
export function sessionFilters(url: URL): SessionFilters | Response {
  const state = url.searchParams.get('state');
  if (state !== null && state !== 'open' && state !== 'ended') return badRequest('state must be open or ended');
  const text = (name: string): string | undefined => {
    const value = url.searchParams.get(name);
    return value === null || value === '' ? undefined : value;
  };
  return { state: state ?? undefined, branch: text('branch'), memberLabel: text('member'), q: text('q') };
}

export async function handleProjectSessions(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  const filters = sessionFilters(ctx.url);
  if (filters instanceof Response) return filters;
  return ok(await listSessionSummaries(env.db, scope, { ...page, ...filters }, ctx.now));
}

export async function handleSession(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const session = await getSession(env.db, scope, sessionId);
  if (session === null) return notFound();
  return ok({ session, counts: await sessionCounts(env.db, scope, sessionId), projectId: scope.projectId });
}

export async function handleSessionChildren(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const query = CHILDREN[ctx.params.child as keyof typeof CHILDREN];
  if (query === undefined) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  if (!(await sessionInScope(env.db, scope, sessionId))) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await query(env.db, scope, sessionId, page));
}

/** A session's turns of the named origins (`origins=user,system,…`; `user` alone when unnamed), oldest first. An origin the wire does not admit is refused. */
export async function handleSessionTurns(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  if (!(await sessionInScope(env.db, scope, sessionId))) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  const origins = parseOrigins(ctx.url.searchParams.get('origins'));
  if (origins === null) return badRequest('origins must name prompt origins');
  return ok(await listTurns(env.db, scope, sessionId, { ...page, origins }));
}

/** One turn's body: the prompt, its responses, attachments and steering children. */
export async function handleSessionTurn(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const detail = await turnDetail(env.db, scope, sessionId, ctx.params.promptId);
  return detail === null ? notFound() : ok(detail);
}

/** One turn's tool calls, oldest first, paged; read when the reader opens them. */
export async function handleSessionTurnToolCalls(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  if (!(await promptInSession(env.db, scope, sessionId, ctx.params.promptId))) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await listToolCalls(env.db, scope, sessionId, { ...page, promptId: ctx.params.promptId }));
}

/** `POST …/sessions/{sessionId}/title`: a person asks for the session's title and summary now, over its opening and closing prompts, replacing what is there. Answers the outcome once the provider has, inside the titling timeout. */
export async function handleTitleSession(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  if (!(await sessionInScope(env.db, scope, sessionId))) return notFound();
  const outcome = await titleSession(env, { projectId: scope.projectId, sessionId, now: ctx.now }, { mode: 'owner', by: ctx.member.id });
  return ok({ outcome });
}

/** Sets a plan's status as an administrative edit by the signed-in member; 404 unless the plan sits in the session, 400 for a status outside the writable set. Answers the row as it stands afterwards. */
export async function handleSetPlanStatus(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const planKey = ctx.params.planKey;
  if (!(await planInSession(env.db, scope, sessionId, planKey))) return notFound();
  let body: unknown;
  try { body = await ctx.request.json(); } catch { return badRequest('status is required'); }
  const status = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
  if (typeof status !== 'string' || !WRITABLE_PLAN_STATUSES.has(status)) return badRequest(PLAN_STATUS_MESSAGE);
  const row = await changePlanStatus(env.db, scope, planKey, status, ctx.member.id, ctx.now);
  return row === null ? notFound() : ok({ plan: row });
}

/** The project's home: what it holds, and what happened most recently. */
export async function handleProjectActivity(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const rawLimit = ctx.url.searchParams.get('limit');
  if (rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) return badRequest('limit must be a positive integer');
  const [items, stats] = await Promise.all([
    activityFeed(env.db, scope, rawLimit === null ? undefined : Number(rawLimit)),
    projectStats(env.db, scope, ctx.now),
  ]);
  return ok({ items, stats });
}

/** A session's transcript record and its segments. The bytes live in the blob store and are fetched per segment through the blob route. */
export async function handleTranscript(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const transcript = await getTranscript(env.db, scope, sessionId);
  if (transcript === null) return notFound();
  return ok({ transcript, segments: await listSegments(env.db, scope, transcript.transcriptId) });
}
