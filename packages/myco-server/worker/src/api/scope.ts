import type { D1Like } from '../env.js';
import type { OwnerSession } from '../auth/owner/cookie.js';
import type { ReadScope } from '../read/scope.js';
import { listProjects, projectExists, sessionInScope as coreSessionInScope, type ProjectRow } from '../read/sessions.js';

/**
 * Who is asking. Today there is one owner and every project is theirs, so this is
 * not read — but a chokepoint whose signature omits the caller localizes nothing:
 * adding per-project grants would change every call site, which is the whole
 * reason the chokepoint exists. It is taken now so phase 2 is one edit here.
 */
export type Principal = OwnerSession;

/** The scope a project id resolves to for this principal, or null when there is no such project it may see. A project the principal does not hold is indistinguishable from one that does not exist. */
export async function resolveProjectScope(db: D1Like, _principal: Principal, projectId: string): Promise<ReadScope | null> {
  return (await projectExists(db, projectId)) ? { projectId } : null;
}

/** True when the session exists inside the already-resolved scope. Sessions are addressed with their project (`sessions` is keyed `(project_id, session_id)`, so a session id alone is not unique), which is what makes this a containment check rather than a lookup that could pick the wrong project's row. */
export const sessionInScope = coreSessionInScope;

/** Every project this principal may see. The one read that answers "what is visible at all" rather than "what is in this scope", so it takes the principal for the same reason `resolveProjectScope` does: phase 2's grant query lands here and nowhere else. */
export async function listVisibleProjects(db: D1Like, _principal: Principal): Promise<ProjectRow[]> {
  return listProjects(db);
}

/** An absent or out-of-scope entity. Never 403: a 403 confirms the thing exists. */
export const notFound = (): Response => Response.json({ error: 'not_found' }, { status: 404 });

/** A malformed request of the caller's own making — terminal, named, never retried. */
export const badRequest = (reason: string): Response => Response.json({ error: 'bad_request', reason }, { status: 400 });

export const ok = (body: unknown): Response => Response.json(body);
