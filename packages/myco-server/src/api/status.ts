import type { CapabilityStatus, ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { schemaVersion } from '../read/meta.js';
import { listVisibleProjects } from './scope.js';
import { ok } from './scope.js';

/**
 * What this Deployment can do, in the product's vocabulary.
 *
 * The operator name for a capability differs by target, so the capability is
 * what a surface states and the operator name is detail it can show alongside.
 * A
 * Deployment with no platform descriptor reports nothing rather than claiming
 * capability it cannot demonstrate.
 */
export function deploymentCapabilities(env: ServerEnv): CapabilityStatus[] {
  return env.platform?.capabilities() ?? [];
}

/** Those capabilities this environment cannot currently perform. */
export function absentCapabilities(env: ServerEnv): CapabilityStatus[] {
  return deploymentCapabilities(env).filter((c) => !c.present);
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
  const capabilities = deploymentCapabilities(env);
  let found: number | null = null;
  let projects: Awaited<ReturnType<typeof listVisibleProjects>> = [];
  try {
    found = await schemaVersion(env.db);
    projects = await listVisibleProjects(env.db, ctx.member, { includeArchived: true });
  } catch {
    return ok({ schema: { expected: SERVER_SCHEMA_VERSION, found: null, matches: false }, capabilities, projects: [] });
  }
  return ok({
    schema: { expected: SERVER_SCHEMA_VERSION, found, matches: found === SERVER_SCHEMA_VERSION },
    capabilities,
    projects: projects.map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount, archivedAt: p.archivedAt })),
  });
}
