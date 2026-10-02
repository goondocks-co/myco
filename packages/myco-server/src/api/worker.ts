import { parseWorkerAccounting, WorkerUsageError } from '@goondocks/myco-shared/worker-usage';
/**
 * The worker control plane: claim, lease, end, and the step log a worker observed.
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
import { WORKER_HEARTBEAT_MS, WORKER_LEASE_MS, WORKER_POLL_IDLE_MS } from '../constants.js';
import { ok } from './scope.js';
import { prepareWorkerRepository } from '../core/worker-repository.js';
import { recordWorkerContact } from '../core/worker-contacts.js';
import { RepositoryInputError } from '@goondocks/myco-shared/repository';
import { parseModelCatalog, parseProfileRefusal, type ProfileCapability } from '@goondocks/myco-shared/execution-profile';
import { recordModelCatalog } from '../core/model-catalogs.js';
import { parseStepPage, WorkerStepsError } from '@goondocks/myco-shared/worker-steps';
import { MYCO_TOOL_OPS } from '../mcp/run-surface.js';
import { storeStepPage } from '../core/run-steps.js';

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
    const { id, authenticated, profile } = entry as Record<string, unknown>;
    const capability = offeredProfile(profile);
    if (typeof id === 'string' && HARNESS_ID_SHAPE.test(id)) out.push({ id, authenticated: authenticated === true, ...(capability === undefined ? {} : { profile: capability }) });
  }
  return out;
}

function offeredProfile(value: unknown): ProfileCapability | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { model, efforts } = value as Record<string, unknown>;
  if (!(model === 'flag' || model === 'config' || model === 'none') || !Array.isArray(efforts)
    || efforts.length > 16 || !efforts.every((effort) => typeof effort === 'string' && effort.length <= 64)) return undefined;
  return { model, efforts };
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
  const harnesses = offered(asked.harnesses);
  const capabilities = Array.isArray(asked.capabilities) ? asked.capabilities.filter((value): value is string => typeof value === 'string') : [];
  const outcome = await claimNextRun(env, {
    tokenId: ctx.tokenId,
    machineId: ctx.machineId,
    harnesses,
    capabilities,
    now: ctx.now,
  });
  // An authenticated claim is contact whatever it answers: a worker told
  // `no_work` is attached and idle, which nothing else in the schema records.
  await recordWorkerContact(env.db, {
    credentialId: ctx.tokenId, machineId: ctx.machineId, offers: harnesses, capabilities,
    reason: outcome.claimed ? 'claimed' : outcome.reason, now: ctx.now,
  });
  // The Deployment decides the cadence and says it on every answer: a worker
  // carries none of its own, so a lease changed here changes what every
  // attached worker does without shipping one.
  if (!outcome.claimed) return ok({ persisted: true, claimed: false, reason: outcome.reason, pollAfterMs: WORKER_POLL_IDLE_MS });
  // `leaseMs` is the lease granted from this request's admission. A worker
  // counts it down on its own clock from when it sent the claim, so the two
  // machines' clocks never have to agree.
  return ok({ persisted: true, claimed: true, heartbeatMs: WORKER_HEARTBEAT_MS, leaseMs: WORKER_LEASE_MS, run: outcome.run });
}

/** Extend the lease on a run this worker holds. `held: false` tells a worker another holds its run now, so it stops driving it. */
export async function handleWorkerLease(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const run = named(asked);
  if (run === null) return ok({ persisted: true, held: false, reason: 'lease names a projectId and a runId' });
  // A worker names the attempt it drives, so a renewal left over from an
  // earlier attempt of the same run never renews the attempt that replaced it.
  // One that names none is a worker from before attempts, and renews as it did;
  // one that names an attempt this route cannot read is refused, as the end is.
  let attemptId: string | undefined;
  try {
    attemptId = parseWorkerAccounting({ attemptId: asked.attemptId }).attemptId;
  } catch (error) {
    if (error instanceof WorkerUsageError) return ok({ persisted: false, code: 'parse', reason: error.message });
    throw error;
  }
  const outcome = await renewLease(env, { tokenId: ctx.tokenId, now: ctx.now }, { ...run, ...(attemptId === undefined ? {} : { attemptId }) });
  // A worker driving a run stops polling the claim, so the renewal is the only
  // contact it makes. It names no offer and no outcome of its own: the stored
  // report keeps its liveness refreshed.
  if (outcome.held) await recordWorkerContact(env.db, { credentialId: ctx.tokenId, machineId: ctx.machineId, now: ctx.now });
  return ok(outcome.held
    ? { persisted: true, held: true, expiresAt: outcome.expiresAt, leaseMs: WORKER_LEASE_MS }
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
  try {
    const outcome = await endLeasedRun(env, { tokenId: ctx.tokenId, now: ctx.now, clock: ctx.clock }, {
      ...run, status, ...parseWorkerAccounting(asked), error: typeof asked.error === 'string' ? asked.error : null,
      refusal: parseProfileRefusal(asked.refusal),
    });
    return ok({ persisted: true, ...outcome });
  } catch (error) {
    if (error instanceof WorkerUsageError) return ok({ persisted: false, code: 'parse', reason: error.message });
    throw error;
  }
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

/**
 * Store the models a worker listed for one harness it offers. A catalog this Deployment cannot read — one naming no
 * harness whose models Settings configures — is answered `recorded: false` with why, in the route's own shape: the
 * worker drops it and lists again later.
 */
export async function handleWorkerModels(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const catalog = parseModelCatalog(asked.catalog);
  if (catalog === null) return ok({ persisted: true, recorded: false, reason: 'the list names no agent whose models Settings sets, or no source, sign-in, listing time or models' });
  await recordModelCatalog(env.db, { machineId: ctx.machineId, catalog, now: ctx.now });
  return ok({ persisted: true, recorded: true, models: catalog.models.length });
}

/**
 * Store one page of the step log a worker observed for an attempt it drove (`core/run-steps.ts`). The attempt, not a
 * live lease, admits it: a log a worker delivers after its run ended or changed hands is filed under the attempt that
 * observed it, and changes nothing about how the run ended. A page that does not parse is refused whole.
 */
export async function handleWorkerSteps(env: ServerEnv, ctx: DeploymentContext): Promise<Response> {
  const asked = body(ctx);
  if (asked === null) return unreadable();
  const run = named(asked);
  if (run === null) return ok({ persisted: false, code: 'parse', reason: 'a step page names a projectId and a runId' });
  const { projectId: _project, runId: _run, ...rest } = asked;
  try {
    const page = parseStepPage(rest, MYCO_TOOL_OPS);
    const outcome = await storeStepPage(env.db, { projectId: run.projectId }, run.runId, page, { tokenId: ctx.tokenId, machineId: ctx.machineId }, ctx.now);
    return ok({ persisted: true, ...outcome });
  } catch (error) {
    if (error instanceof WorkerStepsError) return ok({ persisted: false, code: 'parse', reason: error.message });
    throw error;
  }
}
