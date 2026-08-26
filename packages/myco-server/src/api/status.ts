import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { schemaVersion } from '../read/meta.js';
import { listVisibleProjects } from './scope.js';
import { ok } from './scope.js';

/**
 * The declared infrastructure absent from this environment, in the deployment's
 * own vocabulary. The names belong to the platform, not the core, so the entry
 * point supplies them through `env.platform` — see `core/adapters.ts`.
 */
export function missingBindings(env: ServerEnv): string[] {
  return env.platform?.missingBindings() ?? [];
}

/**
 * Binding and schema sanity for the owner.
 *
 * The schema version is read on every member request, so a Worker bound to a wrong or
 * half-migrated database answers 401 or 503 to every member while a dashboard that only
 * reads its own routes looks perfectly healthy. This is the one surface where that
 * divergence is visible, which is why the parent spec assigns it to this plan.
 */
export async function handleStatus(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  // Infrastructure presence is answered before anything is trusted. A deployment whose
  // relational store is absent or unusable makes a query here throw, and the owner branch
  // answers a bare 503 naming nothing — on the one surface whose job is to name it. The
  // query is attempted and its failure absorbed, which reports the same way on every
  // target: a store that is missing, misconfigured, or unreachable all read as unusable
  // here rather than only the one shape a single platform happens to produce.
  const required = [...(env.platform?.requiredBindings ?? [])];
  const missing = missingBindings(env);
  let found: number | null = null;
  let projects: Awaited<ReturnType<typeof listVisibleProjects>> = [];
  try {
    found = await schemaVersion(env.db);
    projects = await listVisibleProjects(env.db, ctx.session);
  } catch {
    return ok({ schema: { expected: SERVER_SCHEMA_VERSION, found: null, matches: false }, bindings: { required, missing }, projects: [] });
  }
  return ok({
    schema: { expected: SERVER_SCHEMA_VERSION, found, matches: found === SERVER_SCHEMA_VERSION },
    bindings: { required, missing },
    projects: projects.map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount })),
  });
}
