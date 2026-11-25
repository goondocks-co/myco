import { RepositoryInputError } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { githubAppConfigured } from '../core/github-app.js';
import { projectRepositories, RepositoryConflictError } from '../core/repositories.js';
import { projectRepositoryListing } from '../db/github-app/project-repositories.js';
import { githubRefusal } from './github-app.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';

/** Fields of the token-era connection body, each refused by name rather than ignored. */
const REMOVED_FIELDS = ['url', 'username', 'credential'] as const;
const CONFLICT = (reason: string) => Response.json({ error: 'conflict', reason }, { status: 409 });

/** How many live Projects one listing names. */
export const REPOSITORY_LISTING_LIMIT = 500;

/** Every live Project by name with the repository it reads or none, from storage alone. */
export async function handleProjectRepositories(env: ServerEnv): Promise<Response> {
  return ok(await projectRepositoryListing(env.db, REPOSITORY_LISTING_LIMIT));
}

/** The stored connection and whether this server can use it, from storage alone. */
export async function handleRepository(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  return ok({ repository: await projectRepositories(env).describe(ctx.params.projectId), appConfigured: githubAppConfigured(env) });
}

export async function handleSaveRepository(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  const body = await readJsonObject(ctx.request);
  const removed = REMOVED_FIELDS.find(field => body !== null && field in body);
  if (removed !== undefined) {
    return badRequest(`Nothing was saved: \`${removed}\` is no longer accepted. Choose a repository the GitHub App can read and send PUT /api/projects/${ctx.params.projectId}/repository with { installationId, repositoryId, branch, revision }.`);
  }
  if (body === null || typeof body.installationId !== 'number' || typeof body.repositoryId !== 'number' || typeof body.branch !== 'string'
    || !(body.revision === null || typeof body.revision === 'string')) return badRequest('installationId, repositoryId, branch and current revision are required.');
  try {
    const repository = await projectRepositories(env).save(ctx.params.projectId,
      { installationId: body.installationId, repositoryId: body.repositoryId, branch: body.branch, revision: body.revision }, ctx.member.id, ctx.now);
    return ok({ repository, appConfigured: true });
  } catch (error) {
    if (error instanceof RepositoryInputError) return badRequest(error.message);
    if (error instanceof RepositoryConflictError) return CONFLICT(error.message);
    return githubRefusal(error);
  }
}

export async function handleRemoveRepository(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.revision !== 'string') return badRequest('Current revision is required.');
  try {
    await projectRepositories(env).remove(ctx.params.projectId, body.revision);
    return ok({ removed: true });
  } catch (error) {
    if (error instanceof RepositoryConflictError) return CONFLICT(error.message);
    throw error;
  }
}
