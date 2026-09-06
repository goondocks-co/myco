import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';
import { REPOSITORY_TASKS, REPOSITORY_COMMIT_PATTERN, RepositoryInputError } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext, RouteContext } from '../context.js';
import { deploymentSecretStore, SecretValueError } from '../core/secrets.js';
import { projectRepositories, RepositoryConflictError, type RepositoryConnectionWrite } from '../core/repositories.js';
import { pinRepositoryForRun, repositoryPinOfRun } from '../core/runs.js';
import { heldRun } from './run-admission.js';
import { badRequest, notFound, ok, readJsonObject, parseJsonObject, resolveProjectScope } from './scope.js';

const capability = (env: ServerEnv) => projectRepositories(env.db, deploymentSecretStore(env.db, env.wrappingKey));

export async function handleRepository(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  return ok({ repository: await capability(env).describe(ctx.params.projectId) });
}

export async function handleSaveRepository(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.url !== 'string' || typeof body.branch !== 'string'
    || !(body.revision === null || typeof body.revision === 'string')) return badRequest('URL, branch and current revision are required.');
  try {
    const repository = await capability(env).save(ctx.params.projectId, body as unknown as RepositoryConnectionWrite, ctx.member.id, ctx.now);
    return ok({ repository });
  } catch (error) {
    if (error instanceof RepositoryInputError || error instanceof SecretValueError) return badRequest(error.message);
    if (error instanceof RepositoryConflictError) return Response.json({ error: 'conflict', reason: error.message }, { status: 409 });
    throw error;
  }
}

export async function handleRemoveRepository(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.revision !== 'string') return badRequest('Current revision is required.');
  try {
    await capability(env).remove(ctx.params.projectId, body.revision, ctx.member.id, ctx.now);
    return ok({ removed: true });
  } catch (error) {
    if (error instanceof RepositoryConflictError) return Response.json({ error: 'conflict', reason: error.message }, { status: 409 });
    throw error;
  }
}

/** Run preparation and pinning share the same held-task admission. */
export async function handleRunRepository(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  if (body === null || typeof body.runId !== 'string' || !body.runId || body.runId.length > 192) return Response.json(refused(ctx, refusal('runId is required', 'parse')));
  const run = await heldRun(env, ctx, body.runId, REPOSITORY_TASKS);
  if (run === null) return ok({ persisted: true, held: false });
  const repositories = capability(env);
  const current = await repositories.describe(ctx.projectId);
  if (current === null) return ok({ persisted: true, held: true, repository: null });
  const pin = repositoryPinOfRun(run);
  if (pin !== null && (pin.url !== current.url || pin.branch !== current.branch)) {
    return ok({ persisted: true, held: true, error: 'Repository connection changed. Start a new run.' });
  }
  if (body.commit !== undefined) {
    if (typeof body.commit !== 'string' || !REPOSITORY_COMMIT_PATTERN.test(body.commit)
      || body.url !== current.url || body.branch !== current.branch) return Response.json(refused(ctx, refusal('Commit and repository identity must match the run connection.', 'parse')));
    const pinned = await pinRepositoryForRun(env.db, { projectId: ctx.projectId }, run, {
      url: current.url, branch: current.branch, commit: body.commit,
    });
    return ok({ persisted: true, held: pinned !== null, pin: pinned });
  }
  const repository = await repositories.access(ctx.projectId);
  if (repository === null || repository.url !== current.url || repository.branch !== current.branch) {
    return ok({ persisted: true, held: true, error: 'Repository connection changed. Retry preparation.' });
  }
  return Response.json({ persisted: true, held: true, repository: { ...repository, ...(pin === null ? {} : { commit: pin.commit }) } }, {
    headers: { 'cache-control': 'no-store' },
  });
}
