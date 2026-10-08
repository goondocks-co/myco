/**
 * The runner protocol a runner credential speaks beside the worker control plane — its contact and its rotation —
 * and the dashboard's runner list and owner controls. Every decision is `auth/runners.ts`'s.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext, RunnerContext } from '../context.js';
import { WORKER_HEARTBEAT_MS, WORKER_POLL_IDLE_MS } from '../constants.js';
import { deploymentIdentity } from '../auth/authorization.js';
import { controlRunner, listRunners, readRunner, rotateRunnerCredential, runnerWindowOpensAt, type RunnerControl } from '../auth/runners.js';
import { runnerContactStatement } from '../core/worker-contacts.js';
import { ok, parseJsonObject } from './scope.js';

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
  await runnerContactStatement(env.db, {
    runnerId: ctx.auth.runnerId, machineId: reported(body.machineId, 'id'), os: reported(body.os, 'text'), version: reported(body.version, 'id'), now: ctx.now,
  }).run();
  const runner = await readRunner(env.db, ctx.auth.runnerId);
  if (runner === null) throw new Error('an authenticated runner has no row');
  return ok({
    persisted: true,
    runner: { id: runner.id, name: runner.name, state: runner.state, deploymentId: await deploymentIdentity(env.db) },
    credential: { id: ctx.auth.credentialId, expiresAt: ctx.auth.expiresAt, refreshAfter: runnerWindowOpensAt(ctx.auth.expiresAt) },
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
  return ok({ runners: await listRunners(env.db, ctx.now) });
}

/** An owner or administrator's pause, resume or removal of one runner. */
export const handleControlRunner = (control: RunnerControl) => async (env: ServerEnv, ctx: OwnerContext): Promise<Response> => {
  const outcome = await controlRunner(env.db, ctx.member.id, ctx.params.runnerId ?? '', control, ctx.now);
  if (outcome === null) return Response.json({ error: 'not_found' }, { status: 404 });
  return ok(outcome);
};
