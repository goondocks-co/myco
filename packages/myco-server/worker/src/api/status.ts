import type { Env } from '../env.js';
import type { OwnerContext } from '../context.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { schemaVersion } from '../read/meta.js';
import { listVisibleProjects } from './scope.js';
import { ok } from './scope.js';

/** Every binding the worker requires to serve a request. */
export const REQUIRED_BINDINGS = ['MYCO_DB', 'BUCKET', 'SOURCE_LIMIT', 'TOKEN_LIMIT'] as const;

/** The declared bindings absent from this environment. A deploy that drops one — as Plan 2's first production deploy dropped BUCKET — is visible here rather than at the first request that happens to touch it. */
export function missingBindings(env: Env): string[] {
  return REQUIRED_BINDINGS.filter((name) => (env as unknown as Record<string, unknown>)[name] === undefined);
}

/**
 * Binding and schema sanity for the owner.
 *
 * The schema version is read on every member request, so a Worker bound to a wrong or
 * half-migrated database answers 401 or 503 to every member while a dashboard that only
 * reads its own routes looks perfectly healthy. This is the one surface where that
 * divergence is visible, which is why the parent spec assigns it to this plan.
 */
export async function handleStatus(env: Env, ctx: OwnerContext): Promise<Response> {
  // Binding presence is answered before anything is queried. A deploy that dropped MYCO_DB
  // makes a query here throw, and the owner branch answers a bare 503 naming nothing — on
  // the one surface whose job is to name it.
  const missing = missingBindings(env);
  if (missing.includes('MYCO_DB')) {
    return ok({ schema: { expected: SERVER_SCHEMA_VERSION, found: null, matches: false }, bindings: { required: [...REQUIRED_BINDINGS], missing }, projects: [] });
  }
  const found = await schemaVersion(env.MYCO_DB);
  const projects = await listVisibleProjects(env.MYCO_DB, ctx.session);
  return ok({
    schema: { expected: SERVER_SCHEMA_VERSION, found, matches: found === SERVER_SCHEMA_VERSION },
    bindings: { required: [...REQUIRED_BINDINGS], missing },
    projects: projects.map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount })),
  });
}
