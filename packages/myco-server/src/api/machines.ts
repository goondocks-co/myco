/**
 * The machines on the People & machines page: every machine to an admin, and a member's own to a member. A machine is
 * renamed here by an admin, or by the member it belongs to.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { renameMachine } from '../auth/enrollment.js';
import { listMachines } from '../read/machines.js';
import { emit } from '../telemetry.js';
import { badRequest, notFound, ok, readJsonObject } from './scope.js';

/** The longest name a machine takes, in characters. */
export const MACHINE_NAME_MAX = 64;

/** Control, format, surrogate, private-use and unassigned code points, and line and paragraph separators. */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;
/** More combining marks in a row than any script writes on one letter. */
const STACKED_MARKS = /\p{M}{5,}/u;

/** A machine name: 1 to 64 characters once trimmed, every one printable, with no more than four marks on a letter. */
export function machineName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  const length = [...name].length;
  if (length === 0 || length > MACHINE_NAME_MAX || UNPRINTABLE.test(name) || STACKED_MARKS.test(name)) return null;
  return name;
}

export async function handleMachines(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = isAdmin(ctx.member.role) ? { all: true as const } : { all: false as const, memberId: ctx.member.id };
  return ok({ machines: await listMachines(env.db, ctx.now, scope) });
}

/** Rename a machine. Another member's machine answers as an unknown one does, so the answer tells no one which ids exist. */
export async function handleRenameMachine(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const name = machineName(body.label);
  if (name === null) return badRequest(`label must be 1 to ${MACHINE_NAME_MAX} printable characters`);
  const machineId = ctx.params.machineId!;
  if (!(await renameMachine(env.db, { memberId: ctx.member.id, admin: isAdmin(ctx.member.role) }, machineId, name))) return notFound();
  emit({ kind: 'machine_renamed', machineId, actor: ctx.member.id });
  return ok({ machineId, name });
}
