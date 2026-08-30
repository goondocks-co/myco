import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { archiveProject, createProject, renameProject, unarchiveProject } from '../read/sessions.js';
import { emit } from '../telemetry.js';
import { readJsonObject, badRequest, listVisibleProjects, notFound, ok } from './scope.js';

/** The project-id grammar the schema enforces (`db/schema.ts:5`), applied before a write reaches a CHECK constraint. */
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED = new Set(['.', '..']);

/** `GET /api/projects`: the projects that accept capture; `?include=archived` lists the archived ones too. */
export async function handleProjects(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ projects: await listVisibleProjects(env.db, ctx.member, { includeArchived: ctx.url.searchParams.get('include') === 'archived' }) });
}

/** `POST /api/projects/{projectId}/archive`: attributed; a second archive is refused by name. */
export async function handleArchiveProject(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const outcome = await archiveProject(env.db, ctx.params.projectId, ctx.member.id, ctx.now);
  if (outcome === 'absent') return notFound();
  if (outcome === 'already_archived') return Response.json({ error: outcome }, { status: 409 });
  emit({ kind: 'project_archived', projectId: ctx.params.projectId, actor: ctx.member.id });
  return ok({ archived: true, archivedBy: ctx.member.id });
}

/** `POST /api/projects/{projectId}/unarchive`: capture resumes on the next request. */
export async function handleUnarchiveProject(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const outcome = await unarchiveProject(env.db, ctx.params.projectId);
  if (outcome === 'absent') return notFound();
  if (outcome === 'not_archived') return Response.json({ error: outcome }, { status: 409 });
  emit({ kind: 'project_unarchived', projectId: ctx.params.projectId, actor: ctx.member.id });
  return ok({ archived: false });
}

/** `PATCH /api/projects/{projectId}`: a new display name, under the same grammar as creation; an archived project renames too. */
export async function handleRenameProject(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const name = body.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return badRequest('name is required');
  if ((await renameProject(env.db, ctx.params.projectId, name)) === 'absent') return notFound();
  emit({ kind: 'project_renamed', projectId: ctx.params.projectId, actor: ctx.member.id });
  return ok({ projectId: ctx.params.projectId, name });
}

/** Create a project. The owner API onboards a project so a first token can be minted for it; `scripts/mint-local.ts` remains the break-glass mirror. */
export async function handleCreateProject(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const projectId = body.projectId;
  const name = body.name;
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || RESERVED.has(projectId)) {
    return badRequest('projectId must match the project-id grammar');
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return badRequest('name is required');
  if (!(await createProject(env.db, projectId, name, ctx.now))) return badRequest('project already exists');
  return Response.json({ projectId, name, createdAt: ctx.now }, { status: 201 });
}
