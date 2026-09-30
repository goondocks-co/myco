import type { RelationalStore } from '../core/adapters.js';
import type { DashboardMember } from '../auth/identity-link.js';
import { MAX_NAMED_PROJECTS, type ProjectSet, type ReadScope } from '../read/scope.js';
import { existingProjects, listProjects, projectExists, sessionInScope as coreSessionInScope, type ProjectRow } from '../read/sessions.js';
import { normalizeRemote, projectForRemote } from '../core/remotes.js';

/**
 * Who is asking. Today there is one owner and every project is theirs, so this is
 * not read — but a chokepoint whose signature omits the caller localizes nothing:
 * adding per-project grants would change every call site, which is the whole
 * reason the chokepoint exists. It is taken now so phase 2 is one edit here.
 *
 * Narrowed to the id. Scope is a property of the identity, never of what that
 * identity may administer, so a caller that holds only an id — an MCP principal,
 * say — passes what it has instead of inventing a role to satisfy a type.
 */
export type Principal = Pick<DashboardMember, 'id'>;

/** The scope a project id resolves to for this principal, or null when there is no such project it may see. A project the principal does not hold is indistinguishable from one that does not exist. */
export async function resolveProjectScope(db: RelationalStore, _principal: Principal, projectId: string): Promise<ReadScope | null> {
  return (await projectExists(db, projectId)) ? { projectId } : null;
}

/**
 * The scope a tool's tenancy argument resolves to: a project id, or a git
 * remote bound to one.
 *
 * The Project Resolution rule in order — a portable Project id first, then a
 * normalized git remote. A value that is neither, and a remote no Project has
 * claimed, answer null: the same answer a Project the caller may not see gets,
 * so nothing about the Deployment's contents leaks through the difference.
 */
export async function resolveTenancyArgument(db: RelationalStore, principal: Principal, named: string): Promise<ReadScope | null> {
  const direct = await resolveProjectScope(db, principal, named);
  if (direct !== null) return direct;
  const remote = normalizeRemote(named);
  if (remote === null) return null;
  const projectId = await projectForRemote(db, remote);
  return projectId === null ? null : { projectId };
}

/** True when the session exists inside the already-resolved scope. Sessions are addressed with their project (`sessions` is keyed `(project_id, session_id)`, so a session id alone is not unique), which is what makes this a containment check rather than a lookup that could pick the wrong project's row. */
export const sessionInScope = coreSessionInScope;

/** Every project this principal may see. The one read that answers "what is visible at all" rather than "what is in this scope", so it takes the principal for the same reason `resolveProjectScope` does: phase 2's grant query lands here and nowhere else. */
export async function listVisibleProjects(db: RelationalStore, _principal: Principal, opts: { includeArchived?: boolean } = {}): Promise<ProjectRow[]> {
  return listProjects(db, opts);
}

/**
 * The Projects a read across Projects covers: every Project this principal may see when it names none, or exactly the
 * ones it named. Null when a named id is not a Project it may see, which answers the same 404 a single Project's read
 * does. More ids than a read may bind is the caller's mistake, refused by `projectSetParam` before this runs.
 */
export async function resolveProjectSet(db: RelationalStore, _principal: Principal, named: readonly string[]): Promise<ProjectSet | null> {
  if (named.length === 0) return { all: true };
  const unique = [...new Set(named)];
  const held = await existingProjects(db, unique);
  return unique.every((id) => held.has(id)) ? { all: false, projectIds: unique } : null;
}

/** The repeatable `project=` parameter: the ids named, or a refusal for more than one statement may bind. */
export function projectSetParam(url: URL): string[] | Response {
  const named = url.searchParams.getAll('project').filter((id) => id !== '');
  return new Set(named).size > MAX_NAMED_PROJECTS ? badRequest(`project names at most ${MAX_NAMED_PROJECTS} projects`) : [...new Set(named)];
}

/** An instant query parameter in epoch milliseconds: absent, or a refusal naming the parameter when it is not one. */
export function instantParam(url: URL, name: string): number | undefined | Response {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (!/^[0-9]{1,16}$/.test(raw)) return badRequest(`${name} must be an instant in epoch milliseconds`);
  return Number(raw);
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
export function parseJsonObject(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try { return parseJsonObject(await request.text()); } catch { return null; }
}
