/**
 * The machines on the People & machines page: every machine to an admin, and a member's own to a member. A machine is
 * renamed here by an admin, or by the member it belongs to.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { renameMachine } from '../auth/enrollment.js';
import { listMachines, machineActivity, machineInScope, type MachineScope } from '../read/machines.js';
import { revokeMachineCredentialsAsMember } from '../auth/tokens.js';
import { paging } from './sessions.js';
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
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await listMachines(env.db, ctx.now, machineScope(ctx), page));
}

function machineScope(ctx: OwnerContext): MachineScope {
  return isAdmin(ctx.member.role) ? { all: true } : { all: false, memberId: ctx.member.id };
}

/** A claim's events across its credential history, in one bounded merged page. */
export async function handleMachineActivity(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  if (page.cursor !== undefined && !/^[0-9]+:[^:]+:.+$/.test(page.cursor)) return badRequest('malformed cursor');
  if (!(await machineInScope(env.db, ctx.params.machineId, machineScope(ctx)))) return notFound();
  return ok(await machineActivity(env.db, ctx.params.machineId, page));
}

/** Stop every live credential on a machine through the credential revocation authority. */
export async function handleStopMachine(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (!(await machineInScope(env.db, ctx.params.machineId, machineScope(ctx)))) return notFound();
  return ok(await revokeMachineCredentialsAsMember(env.db, ctx.member, ctx.params.machineId, ctx.now));
}

/** Rename a machine. Another member's machine answers as an unknown one does, so the answer tells no one which ids exist. */
export async function handleRenameMachine(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const name = machineName(body.label);
  if (name === null) return badRequest(`label must be 1 to ${MACHINE_NAME_MAX} printable characters`);
  const machineId = ctx.params.machineId!;
  if (!(await renameMachine(env.db, { memberId: ctx.member.id }, machineId, name))) return notFound();
  emit({ kind: 'machine_renamed', machineId, actor: ctx.member.id });
  return ok({ machineId, name });
}
