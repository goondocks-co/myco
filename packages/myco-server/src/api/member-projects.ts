/**
 * A member's own view of the Deployment's projects, over the CLI credential (#1499).
 *
 * `myco member join`, run inside a repository, connects that folder to a project on the member's Deployment: it lists
 * the projects to pick one, or creates one named for the folder. Both are credential-scoped member routes, answered to
 * any live member.
 *
 * Creating a project is not new authority. A member's capture already creates the project its header names the first
 * time the Deployment sees it (`ingest/projects.ts` `resolveProject`), under the same `MAX_PROJECTS` ceiling; this
 * route makes that creation explicit and named, so the dashboard shows the project before its first session.
 * Renaming, archiving and every other change to a project stay with an admin on the dashboard.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { CredentialContext } from '../context.js';
import { emptyBodyRoute } from '../auth/members.js';
import { MAX_PROJECTS } from '../constants.js';
import { createNamedProject } from '../ingest/projects.js';
import { listVisibleProjects, ok, parseJsonObject } from './scope.js';
import { emit } from '../telemetry.js';

/** The longest name a project carries, as the dashboard's own rename admits. */
export const PROJECT_NAME_MAX = 200;

/** A fresh project id in the `proj_<32 hex>` form every project a machine has named uses. */
const freshProjectId = (): string => `proj_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** `POST /members/projects/list`: every project that accepts capture, newest activity first, with its session count. */
export const handleMemberProjectList = emptyBodyRoute(async (env: ServerEnv, ctx: CredentialContext) => {
  const projects = await listVisibleProjects(env.db, { id: ctx.memberId });
  return ok({ persisted: true, projects: projects.map((p) => ({ projectId: p.projectId, name: p.name, sessionCount: p.sessionCount, lastActivityAt: p.lastActivityAt })) });
});

/**
 * `POST /members/projects` with `{ name }`: create a project for the member to connect a folder to, under the same
 * ceiling capture creates projects under. Answers the new project's id; a Deployment at its ceiling creates nothing and
 * says so.
 */
export async function handleCreateMemberProject(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > PROJECT_NAME_MAX) return ok({ persisted: false, code: 'invalid_field', reason: `name is required, at most ${PROJECT_NAME_MAX} characters` });
  const projectId = freshProjectId();
  if (!(await createNamedProject(env.db, projectId, name, ctx.now))) return ok({ persisted: false, code: 'refused', reason: `this Deployment already holds ${MAX_PROJECTS} projects; an admin can archive one from the dashboard` });
  emit({ kind: 'project_created', projectId, actor: ctx.memberId });
  return ok({ persisted: true, projectId, name });
}
