import { readRunFields } from './run-fields.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';
import { RepositoryInputError } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext, RouteContext } from '../context.js';
import { deploymentSecretStore, SecretValueError } from '../core/secrets.js';
import { projectRepositories, RepositoryConflictError, type RepositoryConnectionWrite } from '../core/repositories.js';
import { prepareRunRepository } from '../core/run-repository.js';
import { CONTROL_TASKS, heldRun } from './run-admission.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';

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
  const body = readRunFields(ctx.body, '/runs/repository');
  if (body === null || body.runId === null) return Response.json(refused(ctx, refusal('runId is required', 'parse')));
  const run = await heldRun(env, ctx, body.runId, CONTROL_TASKS['/runs/repository']!);
  if (run === null || run.leaseExpiresAt !== null) return ok({ persisted: true, held: false });
  try {
    return Response.json(await prepareRunRepository(env, ctx.projectId, run, body), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof RepositoryInputError) return Response.json(refused(ctx, refusal(error.message, 'parse')));
    throw error;
  }
}
