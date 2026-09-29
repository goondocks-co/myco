/**
 * An owner's request to read stored transcripts again, after a parser fix.
 *
 * `POST /api/transcripts/reread` with `{ agent }` rereads every transcript that
 * agent's parser reads; with `{ projectId, sessionId }`, one session's, in a
 * Project the owner can see (an unknown Project answers 404). It
 * rewinds the parse (`rereadTranscripts`), wakes the Deployment so the tick
 * starts on it, and answers how many transcripts it rewound. The parse itself
 * runs in the tick under its ordinary budget, not in this request.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { rereadTranscripts, type RereadSelector } from '../ingest/parse.js';
import { parserFor } from '../ingest/parsers/registry.js';
import { emit } from '../telemetry.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

function selectorOf(body: Record<string, unknown> | null): RereadSelector | string {
  if (body === null) return 'the body must be a JSON object';
  const { agent, projectId, sessionId } = body;
  if (agent !== undefined) {
    if (projectId !== undefined || sessionId !== undefined) return 'name an agent, or a project and a session, not both';
    if (typeof agent !== 'string' || parserFor(agent) === null) return 'agent must name an agent whose transcripts the Deployment parses';
    return { agent };
  }
  if (typeof projectId !== 'string' || !ID.test(projectId) || typeof sessionId !== 'string' || !ID.test(sessionId)) {
    return 'name an agent, or a projectId and a sessionId';
  }
  return { projectId, sessionId };
}

export async function handleRereadTranscripts(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const selector = selectorOf(await readJsonObject(ctx.request));
  if (typeof selector === 'string') return badRequest(selector);
  // A session is named inside a Project, and the Project is resolved as every project-scoped owner route resolves it.
  if ('projectId' in selector) {
    const scope = await resolveProjectScope(env.db, ctx.member, selector.projectId);
    if (scope === null) return notFound();
    selector.projectId = scope.projectId;
  }
  const reread = await rereadTranscripts(env.db, selector);
  emit({ kind: 'transcripts_reread_requested', actor: ctx.member.id, transcripts: reread });
  try { await env.wake?.(); } catch { /* the clock's floor still wakes the Deployment */ }
  return ok({ reread });
}
