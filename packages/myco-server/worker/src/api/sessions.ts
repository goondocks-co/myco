import type { Env } from '../env.js';
import type { OwnerContext } from '../context.js';
import { getSession, listSessions, sessionCounts } from '../read/sessions.js';
import { badRequest, notFound, ok, resolveProjectScope, sessionInScope } from './scope.js';
import { decodeCursor } from '../read/scope.js';
import { listAttachments, listPlans, listPrompts, listResponses, listToolCalls } from '../read/children.js';
import { getTranscript, listSegments } from '../read/transcript.js';

/** The five child collections, by URL segment. One handler serves all of them: they differ only in which query runs. */
const CHILDREN = {
  prompts: listPrompts,
  'tool-calls': listToolCalls,
  responses: listResponses,
  plans: listPlans,
  attachments: listAttachments,
} as const;

export const CHILD_SEGMENTS = Object.keys(CHILDREN);

/** The caller's paging arguments, or a refusal. A malformed cursor is refused rather than ignored: silently serving page one to a client that asked for page nine loses rows without saying so. */
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

export function paging(url: URL): { limit?: number; cursor?: string } | Response {
  const rawLimit = url.searchParams.get('limit');
  const rawCursor = url.searchParams.get('cursor');
  if (rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) return badRequest('limit must be a positive integer');
  if (rawCursor !== null && decodeCursor(rawCursor) === null) return badRequest('malformed cursor');
  return { limit: rawLimit === null ? undefined : Number(rawLimit), cursor: rawCursor ?? undefined };
}

export async function handleProjectSessions(env: Env, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.MYCO_DB, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await listSessions(env.MYCO_DB, scope, page));
}

export async function handleSession(env: Env, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.MYCO_DB, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  const session = await getSession(env.MYCO_DB, scope, sessionId);
  if (session === null) return notFound();
  return ok({ session, counts: await sessionCounts(env.MYCO_DB, scope, sessionId), projectId: scope.projectId });
}

export async function handleSessionChildren(env: Env, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const query = CHILDREN[ctx.params.child as keyof typeof CHILDREN];
  if (query === undefined) return notFound();
  const scope = await resolveProjectScope(env.MYCO_DB, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  if (!(await sessionInScope(env.MYCO_DB, scope, sessionId))) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await query(env.MYCO_DB, scope, ctx.params.sessionId, page));
}

/** A session's transcript record and its segments. The bytes live in R2 and are fetched per segment through the blob route. */
export async function handleTranscript(env: Env, ctx: OwnerContext): Promise<Response> {
  const sessionId = sessionIdParam(ctx.params.sessionId);
  if (sessionId === null) return notFound();
  const scope = await resolveProjectScope(env.MYCO_DB, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  const transcript = await getTranscript(env.MYCO_DB, scope, sessionId);
  if (transcript === null) return notFound();
  return ok({ transcript, segments: await listSegments(env.MYCO_DB, scope, transcript.transcriptId) });
}
