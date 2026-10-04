/**
 * A machine's settings on the dashboard (#1393): read and set by the member the machine joined as, and by nobody else.
 * The machine is the path's alone: a body naming another machine changes nothing about which one is written.
 * Setting a leaf to its default resets it. The machine picks a change up at its next session start.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { machineAccess, readMachineSettings, setMachineLeaf, resetMachineLeaf } from '../core/machine-settings.js';
import { notFound, ok, readJsonObject } from './scope.js';

const forbidden = (): Response => Response.json({ applied: false, reason: 'forbidden', detail: 'only the member this machine belongs to reaches its settings' }, { status: 403 });

/** Every leaf of one machine. */
export async function handleMachineSettings(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const machineId = ctx.params.machineId!;
  const access = await machineAccess(env.db, ctx.member.id, machineId);
  if (access === 'absent') return notFound();
  if (access === 'forbidden') return forbidden();
  return ok({ machineId, leaves: await readMachineSettings(env.db, machineId) });
}

/** Set one leaf of one machine; its default resets it. */
export async function handleSetMachineSetting(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const machineId = ctx.params.machineId!;
  const access = await machineAccess(env.db, ctx.member.id, machineId);
  if (access === 'absent') return notFound();
  if (access === 'forbidden') return forbidden();
  const body = await readJsonObject(ctx.request);
  if (body === null || !('value' in body)) return Response.json({ applied: false, reason: 'malformed', detail: 'body must be a JSON object carrying a value' }, { status: 400 });
  const written = body.reset === true
    ? await resetMachineLeaf(env.db, machineId, ctx.params.leaf!, ctx.member.id, ctx.now)
    : await setMachineLeaf(env.db, machineId, ctx.params.leaf!, body.value, ctx.member.id, ctx.now);
  if (written.applied) return ok({ applied: true });
  if (written.reason === 'absent') return notFound();
  return Response.json(written, { status: 400 });
}
