/**
 * The machines on the People & machines page: every machine to an admin, and a member's own to a member. A machine is
 * renamed here by an admin, or by the member it belongs to.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { renameMachine } from '../auth/tokens.js';
import { listMachines } from '../read/machines.js';
import { emit } from '../telemetry.js';
import { badRequest, notFound, ok, readJsonObject } from './scope.js';

/** The longest name a machine takes, in characters. */
export const MACHINE_NAME_MAX = 64;

/** A machine name: 1 to 64 characters once trimmed, none of them a control, format or line-breaking character. */
export function machineName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  const length = [...name].length;
  if (length === 0 || length > MACHINE_NAME_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return null;
  return name;
}

export async function handleMachines(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = isAdmin(ctx.member.role) ? { all: true as const } : { all: false as const, memberId: ctx.member.id };
  return ok({ machines: await listMachines(env.db, ctx.now, scope) });
}

export async function handleRenameMachine(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const name = machineName(body.label);
  if (name === null) return badRequest(`label must be 1 to ${MACHINE_NAME_MAX} printable characters`);
  const machineId = ctx.params.machineId!;
  const renamed = await renameMachine(env.db, { memberId: ctx.member.id, admin: isAdmin(ctx.member.role) }, machineId, name, ctx.now);
  if (renamed.renamed) {
    emit({ kind: 'machine_renamed', machineId, actor: ctx.member.id });
    return ok({ machineId, name: renamed.name });
  }
  if (renamed.reason === 'absent') return notFound();
  if (renamed.reason === 'forbidden') return Response.json({ error: 'forbidden', detail: 'only an admin or the member this machine belongs to renames it' }, { status: 403 });
  return Response.json({ error: 'no_live_credential', detail: 'this machine holds no live credential to carry a name' }, { status: 409 });
}
