/**
 * The worker control plane: claim, lease, end.
 *
 * A worker is not a member doing member work and not the run it drives. It
 * holds a Deployment-scoped credential, takes one run at a time from the claim
 * queue, and holds that run on a lease it renews. The model it launches never
 * reaches these routes: the harness child speaks the run-scoped MCP surface and
 * nothing else, and the run credential this route answers with is refused here.
 *
 * Every decision is `core/harness.ts`'s; these handlers decide only how a
 * worker asks and how it is answered. An outcome a worker can act on — no work,
 * no harness it can run, a lease it no longer holds — is answered in the
 * route's own shape rather than refused: none of them is a failure of
 * authority, and a worker's next poll is the right response to all three. A
 * body that does not parse is a different thing and is refused.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { DeploymentContext } from '../context.js';
import { claimNextRun, endLeasedRun, renewLease, type OfferedHarness } from '../core/harness.js';
import { WORKER_HEARTBEAT_MS, WORKER_POLL_IDLE_MS } from '../constants.js';
import { ok } from './scope.js';
import { prepareWorkerRepository } from '../core/worker-repository.js';
import { RepositoryInputError } from '@goondocks/myco-shared/repository';

const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
const RUN_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;
const HARNESS_ID_SHAPE = /^[a-z0-9-]{1,64}$/;

/** The asked body, or null when it is not a JSON object. */
function body(ctx: DeploymentContext): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(ctx.body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A body this route cannot read at all, answered in the route's own shape with the classifier that names it. */
const unreadable = (): Response => ok({ persisted: false, code: 'parse', reason: 'body must be a JSON object' });

/** The harnesses a worker offers, as it reports them. An id the Deployment does not know simply matches no preference. */
function offered(value: unknown): OfferedHarness[] {
  if (!Array.isArray(value)) return [];
  const out: OfferedHarness[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const { id, authenticated } = entry as Record<string, unknown>;
    if (typeof id === 'string' && HARNESS_ID_SHAPE.test(id)) out.push({ id, authenticated: authenticated === true });
  }
  return out;
}

function named(value: Record<string, unknown>): { projectId: string; runId: string } | null {
  const projectId = typeof value.projectId === 'string' && PROJECT_ID_SHAPE.test(value.projectId) ? value.projectId : null;
  const runId = typeof value.runId === 'string' && RUN_ID_SHAPE.test(value.runId) ? value.runId : null;
  return projectId === null || runId === null ? null : { projectId, runId };
}

/**
 * Take the next run this worker can run, or answer that there is none.
 *
 * The answer carries a run credential and, where the Deployment holds one, the
 * harness credential the run's child reads. Both are the Deployment's authority
 * rather than a member's, which is why the pipeline admits only an administrator
 * here.
 */
export async function handleWorkerClaim(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const outcome = await claimNextRun(env, {
    tokenId: ctx.tokenId,
    machineId: ctx.machineId,
    harnesses: offered(asked.harnesses),
    capabilities: Array.isArray(asked.capabilities) ? asked.capabilities.filter((value): value is string => typeof value === 'string') : [],
    now: ctx.now,
  });
  // The Deployment decides the cadence and says it on every answer: a worker
  // carries none of its own, so a lease changed here changes what every
  // attached worker does without shipping one.
  if (!outcome.claimed) return ok({ persisted: true, claimed: false, reason: outcome.reason, pollAfterMs: WORKER_POLL_IDLE_MS });
  return ok({ persisted: true, claimed: true, heartbeatMs: WORKER_HEARTBEAT_MS, run: outcome.run });
}

/** Extend the lease on a run this worker holds. `held: false` tells a worker another holds its run now, so it stops driving it. */
export async function handleWorkerLease(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const run = named(asked);
  if (run === null) return ok({ persisted: true, held: false, reason: 'lease names a projectId and a runId' });
  const outcome = await renewLease(env, { tokenId: ctx.tokenId, now: ctx.now }, run);
  return ok(outcome.held
    ? { persisted: true, held: true, expiresAt: outcome.expiresAt }
    : { persisted: true, held: false, reason: 'the lease is no longer held' });
}

/** End a run this worker leases. The lease authorizes the write; the run's own credential never ends its run. */
export async function handleWorkerEnd(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const run = named(asked);
  if (run === null) return ok({ persisted: true, ended: false, reason: 'end names a projectId and a runId' });
  const status = asked.status === 'completed' || asked.status === 'failed' ? asked.status : null;
  if (status === null) return ok({ persisted: true, ended: false, reason: 'end names a status of completed or failed' });
  const outcome = await endLeasedRun(env, { tokenId: ctx.tokenId, now: ctx.now }, {
    ...run, status, error: typeof asked.error === 'string' ? asked.error : null,
  });
  return ok({ persisted: true, ...outcome });
}

/** Repository access and commit pinning under the worker's lease. */
export async function handleWorkerRepository(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const run = named(asked);
  if (run === null) return ok({ persisted: false, code: 'parse', reason: 'repository names a projectId and a runId' });
  try {
    const result = await prepareWorkerRepository(env, { tokenId: ctx.tokenId, clock: ctx.clock }, { ...run, body: asked });
    return Response.json({ persisted: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof RepositoryInputError) return ok({ persisted: false, code: 'parse', reason: error.message });
    throw error;
  }
}
