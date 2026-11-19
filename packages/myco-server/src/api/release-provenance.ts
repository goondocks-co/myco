import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import {
  releaseProvenance, ReleaseProvenanceConflictError, ReleaseProvenanceInputError, type ReleaseProvenanceWrite,
} from '../core/release-provenance.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';

const capability = (env: ServerEnv) => releaseProvenance(env.db);
/** Fields release tracking no longer stores, each refused by name rather than ignored. */
const REMOVED_FIELDS = ['credential', 'githubRepo'] as const;

export async function handleReleaseProvenance(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  return ok({ releaseProvenance: await capability(env).describe(ctx.params.projectId) });
}

export async function handleSaveReleaseProvenance(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  const body = await readJsonObject(ctx.request);
  if (body === null || !(body.revision === null || typeof body.revision === 'string')) return badRequest('The current revision is required.');
  const removed = REMOVED_FIELDS.find(field => field in body);
  if (removed !== undefined) {
    return badRequest(`Nothing was saved: \`${removed}\` is no longer accepted. Release tracking reads the Project’s connected repository; connect it with PUT /api/projects/${ctx.params.projectId}/repository, then save release tracking without \`${removed}\`.`);
  }
  try {
    return ok({ releaseProvenance: await capability(env).save(ctx.params.projectId, body as unknown as ReleaseProvenanceWrite, ctx.member.id, ctx.now) });
  } catch (error) {
    if (error instanceof ReleaseProvenanceInputError) return badRequest(error.message);
    if (error instanceof ReleaseProvenanceConflictError) return Response.json({ error: 'conflict', reason: error.message }, { status: 409 });
    throw error;
  }
}

/** Asks for a check on the next tick and wakes the Deployment; the check itself runs in the job, inside its budget. */
export async function handleRequestReleaseCheck(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (await resolveProjectScope(env.db, ctx.member, ctx.params.projectId) === null) return notFound();
  const requested = await capability(env).requestCheck(ctx.params.projectId, ctx.now);
  if (!requested) return Response.json({ error: 'not_enabled', reason: 'Turn on release tracking before checking.' }, { status: 409 });
  await env.wake?.().catch(() => undefined);
  return ok({ requested: true, releaseProvenance: await capability(env).describe(ctx.params.projectId) });
}
