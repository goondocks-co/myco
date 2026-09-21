/**
 * Store maintenance, for the operator: what each check can do on this target and what it last found, and the
 * request that runs one now. Both read and run through `core/store-maintenance.ts`, the one path the clock's
 * jobs take as well.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isMaintenanceCheck, maintenanceStatus, runMaintenance } from '../core/store-maintenance.js';
import { notFound, ok } from './scope.js';

/** `GET /api/maintenance`: every check's support on this target, its cadence, and its latest recorded outcome. */
export async function handleMaintenanceStatus(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ checks: await maintenanceStatus(env, ctx.now) });
}

/**
 * `POST /api/maintenance/{check}/run`: runs the check now, outside its cadence, and answers the recorded outcome.
 * A refusal — unsupported here, or a run already in progress — answers 409 with its name and reason.
 */
export async function handleRunMaintenance(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const check = ctx.params.check ?? '';
  if (!isMaintenanceCheck(check)) return notFound();
  const answer = await runMaintenance(env, check, 'owner', ctx.now);
  if (answer.outcome === 'refused') return Response.json({ error: 'refused', refusal: answer.refusal, reason: answer.reason }, { status: 409 });
  return ok(answer.record);
}
