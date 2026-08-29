import type { RelationalStore } from '../core/adapters.js';
import type { DashboardMember } from '../auth/identity-link.js';
import type { ReadScope } from '../read/scope.js';
import { listProjects, projectExists, sessionInScope as coreSessionInScope, type ProjectRow } from '../read/sessions.js';

/**
 * Who is asking. Today there is one owner and every project is theirs, so this is
 * not read — but a chokepoint whose signature omits the caller localizes nothing:
 * adding per-project grants would change every call site, which is the whole
 * reason the chokepoint exists. It is taken now so phase 2 is one edit here.
 */
export type Principal = DashboardMember;

/** The scope a project id resolves to for this principal, or null when there is no such project it may see. A project the principal does not hold is indistinguishable from one that does not exist. */
export async function resolveProjectScope(db: RelationalStore, _principal: Principal, projectId: string): Promise<ReadScope | null> {
  return (await projectExists(db, projectId)) ? { projectId } : null;
}

/** True when the session exists inside the already-resolved scope. Sessions are addressed with their project (`sessions` is keyed `(project_id, session_id)`, so a session id alone is not unique), which is what makes this a containment check rather than a lookup that could pick the wrong project's row. */
export const sessionInScope = coreSessionInScope;

/** Every project this principal may see. The one read that answers "what is visible at all" rather than "what is in this scope", so it takes the principal for the same reason `resolveProjectScope` does: phase 2's grant query lands here and nowhere else. */
export async function listVisibleProjects(db: RelationalStore, _principal: Principal): Promise<ProjectRow[]> {
  return listProjects(db);
}

/** An absent or out-of-scope entity. Never 403: a 403 confirms the thing exists. */
export const notFound = (): Response => Response.json({ error: 'not_found' }, { status: 404 });

/** A malformed request of the caller's own making — terminal, named, never retried. */
export const badRequest = (reason: string): Response => Response.json({ error: 'bad_request', reason }, { status: 400 });

export const ok = (body: unknown): Response => Response.json(body);

/**
 * The request body as a JSON object, or null for anything else — malformed text,
 * `null`, an array, a scalar. A caller dereferencing a body that is not an object
 * would throw, and the owner branch answers a throw as a retryable 503; a body of
 * the caller's own making is refused as terminal instead.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}
