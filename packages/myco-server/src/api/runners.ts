import { isAdmin } from '../auth/roles.js';
import { machinesOf } from '../read/machines.js';
/**
 * The runner protocol a runner credential speaks beside the worker control plane — its contact and its rotation —
 * and the dashboard's runner list and owner controls. Every decision is `auth/runners.ts`'s.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext, RunnerContext } from '../context.js';
import { WORKER_HEARTBEAT_MS, WORKER_POLL_IDLE_MS } from '../constants.js';
import { deploymentIdentity } from '../auth/authorization.js';
import { controlRunner, renameRunner, registerRunner, RUNNER_NAME_PATTERN, readRunner, rotateRunnerCredential, runnerWindowOpensAt, type RunnerControl } from '../auth/runners.js';
import { runnerContactStatement, runnerObservationStatement, readWorkerFleet } from '../core/worker-contacts.js';
import { readFleetProjection } from '../read/fleet.js';
import { requestByUserCode } from '../auth/device.js';
import { sha256Hex } from '../hash.js';
import type { RunnerAvailability } from '@goondocks/myco-shared/runner-fleet';
import { forgetLegacyWorker } from '../core/legacy-workers.js';
import { parseRunnerUpdateReport, readRunnerUpdateRequest, requestRunnerUpdate, runnerUpdateReportStatements } from '../core/runner-updates.js';
import { emit } from '../telemetry.js';
import { ok, parseJsonObject, readJsonObject } from './scope.js';

const REPORTED_ID = /^[A-Za-z0-9._-]{1,64}$/;
const REPORTED_TEXT_MAX = 128;

/** A reported metadata field this route keeps, or null where the runner sent none it can keep. */
function reported(value: unknown, shape: 'id' | 'text'): string | null {
  if (typeof value !== 'string') return null;
  if (shape === 'id') return REPORTED_ID.test(value) ? value : null;
  return value.trim().length > 0 && value.length <= REPORTED_TEXT_MAX && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
}

/**
 * A runner's contact: what it reports about its machine is recorded as metadata, never as authentication, under the
 * runner write guard, and the answer is its own registration as this Deployment holds it after that write, the
 * credential it presented, and the cadence it keeps.
 * A client that holds its candidate but not the registration reply recovers its record here.
 */
export async function handleRunnerContact(env: ServerEnv, ctx: RunnerContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  if (body === null) return ok({ persisted: false, code: 'parse', reason: 'body must be a JSON object' });
  const update = body.update === undefined ? null : parseRunnerUpdateReport(body.update, ({ field, disposition }) =>
    emit({ kind: 'runner_update_metadata', reason: 'invalid_field', runnerId: ctx.auth.runnerId, field, disposition }));
  await env.db.batch([runnerContactStatement(env.db, {
    runnerId: ctx.auth.runnerId, machineId: reported(body.machineId, 'id'), os: reported(body.os, 'text'), version: reported(body.version, 'id'), now: ctx.now,
  }), ...(body.availability === undefined && body.arch === undefined ? [] : [runnerObservationStatement(env.db, ctx.auth.runnerId, {
    arch: reported(body.arch, 'text'),
    state: (['ready', 'settling', 'user_active', 'incompatible', 'unknown'] as const).includes(body.availability as RunnerAvailability) ? body.availability as RunnerAvailability : 'unknown',
    reason: reported(body.readinessReason, 'text') ?? 'Readiness reason unavailable.',
  }, ctx.now)]), ...(update === null ? [] : await runnerUpdateReportStatements(env.db, ctx.auth.runnerId, update))]);
  const runner = await readRunner(env.db, ctx.auth.runnerId);
  if (runner === null) throw new Error('an authenticated runner has no row');
  return ok({
    persisted: true,
    runner: { id: runner.id, name: runner.name, state: runner.state, deploymentId: await deploymentIdentity(env.db) },
    credential: { id: ctx.auth.credentialId, expiresAt: ctx.auth.expiresAt, refreshAfter: runnerWindowOpensAt(ctx.auth.expiresAt) },
    updateRequest: await readRunnerUpdateRequest(env.db, ctx.auth.runnerId),
    heartbeatMs: WORKER_HEARTBEAT_MS, pollIdleMs: WORKER_POLL_IDLE_MS,
  });
}

/** Bind the successor the runner staged; see `rotateRunnerCredential` for idempotence and the refresh window. */
export async function handleRunnerRotate(env: ServerEnv, ctx: RunnerContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  if (body === null) return ok({ persisted: false, code: 'parse', reason: 'body must be a JSON object' });
  const rotation = await rotateRunnerCredential(env.db, ctx.auth, body.candidate, ctx.now);
  if (rotation.rotated) return ok({ persisted: true, ...rotation });
  if (rotation.code === 'refresh_too_early') return ok({ persisted: true, rotated: false, code: rotation.code, refreshAfter: rotation.refreshAfter });
  if (rotation.code === 'revoked') return ok({ persisted: false, code: 'refused', reason: rotation.reason });
  return ok({ persisted: false, code: 'parse', reason: rotation.reason });
}

/** Every runner with its state, last contact and live lease, for any member: read-only. */
export async function handleListRunners(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const projection = await readFleetProjection(env, ctx.now);
  if (isAdmin(ctx.member.role)) return ok(projection);
  const own = await machinesOf(env.db, ctx.member.id);
  return ok({ ...projection, fleet: projection.fleet.filter(row => row.runner !== null || (row.machineId !== null && own.has(row.machineId))),
    legacyWorkers: projection.legacyWorkers.filter(row => row.machineId !== null && own.has(row.machineId)) });
}

/** Member-credential executors and their valid leases, from the shared fleet projection. */
export async function handleLegacyWorkers(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const fleet = await readWorkerFleet(env.db, ctx.now);
  return ok({ workers: fleet.filter((worker) => worker.runner === null) });
}

export async function handleForgetLegacyWorker(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const forgotten = await forgetLegacyWorker(env.db, ctx.member.id, ctx.params.credentialId ?? '', ctx.now);
  return forgotten ? ok({ forgotten: true }) : Response.json({ error: 'worker_not_offline' }, { status: 409 });
}

/** An owner or administrator's pause, resume or removal of one runner. */
export const handleControlRunner = (control: RunnerControl) => async (env: ServerEnv, ctx: OwnerContext): Promise<Response> => {
  const outcome = await controlRunner(env.db, ctx.member.id, ctx.params.runnerId ?? '', control, ctx.now);
  if (outcome === null) return Response.json({ error: 'not_found' }, { status: 404 });
  return ok(outcome);
};

/** An attributed request to check and update at the runner's next idle point. */
export async function handleRequestRunnerUpdate(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const outcome = await requestRunnerUpdate(env.db, ctx.member.id, ctx.params.runnerId ?? '', ctx.now);
  if (!outcome.requested) return Response.json({ error: outcome.code }, { status: outcome.code === 'not_found' ? 404 : (outcome.code === 'disconnected' || outcome.code === 'unsupported_channel') ? 409 : 403 });
  return ok(outcome);
}

export async function handleRenameRunner(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (typeof body?.name !== 'string' || !RUNNER_NAME_PATTERN.test(body.name)) return Response.json({ error: 'invalid_name' }, { status: 400 });
  const runner = await renameRunner(env.db, ctx.member.id, ctx.params.runnerId ?? '', body.name, ctx.now);
  return runner === null ? Response.json({ error: 'not_found' }, { status: 404 }) : ok({ runner });
}

/** A replacement is approved on the existing identity through the same one-time device decision as registration. */
export async function handleRecredentialRunner(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  const result = await registerRunner(env.db, ctx.member.id, row.id, await sha256Hex(row.source_ip), ctx.now, ctx.params.runnerId ?? '');
  return result === null ? Response.json({ error: 'approval_refused' }, { status: 409 }) : ok({ approved: true, ...result });
}
