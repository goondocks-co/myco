import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { createProject } from '../read/sessions.js';
import { readJsonObject, badRequest, listVisibleProjects, ok } from './scope.js';

/** The project-id grammar the schema enforces (`db/schema.ts:5`), applied before a write reaches a CHECK constraint. */
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED = new Set(['.', '..']);

export async function handleProjects(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ projects: await listVisibleProjects(env.db, ctx.member) });
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
