/**
 * Connect a repository a member's machine could not capture, from "Needs you" (#1547).
 *
 * `POST /api/uncaptured/{machineId}/{rootKey}/connect`, optionally with `{ projectId }`: the member the machine belongs
 * to, or an admin, tells that machine to join the repository. With a project named, the repository joins it, and its
 * remote, where it has one, is bound to it, so every other clone and worktree of it joins the same project. With none,
 * it joins the project its remote names or one created for it, which only an admin may ask of a Deployment that keeps
 * project creation with admins. Nothing is joined here: the machine joins at a hook in that repository, within minutes.
 * Another member's machine answers as an unknown one does.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { connectMachineRoot } from '../core/machine-settings.js';
import { projectForRemote, recordProjectRemote } from '../core/remotes.js';
import { getUncaptured, listUncaptured } from '../read/uncaptured.js';
import { ownMachineNames } from '../read/capture.js';
import { HELD_STATES, isUncapturedReason, type HeldState, type UncapturedReason } from '@goondocks/myco-shared/member-protocol';

const isHeldState = (value: string): value is HeldState => (HELD_STATES as readonly string[]).includes(value);
import { emit } from '../telemetry.js';
import { mayCreateProjects } from './member-projects.js';
import { clearUncapturedStatement } from '../ingest/uncaptured.js';
import { badRequest, listVisibleProjects, notFound, ok, readJsonObject } from './scope.js';

/**
 * One repository a member's machine could not capture, as `GET /api/uncaptured` answers it for "Needs you": its folder
 * name, never a path; its machine, named to the member it belongs to alone; the member; and why. Connect it with
 * `POST /api/uncaptured/{machineId}/{rootKey}/connect`.
 */
export interface UncapturedRootItem {
  machineId: string;
  /** The machine's name, to the member it belongs to alone; null to anyone else, and while it has none. */
  machineName: string | null;
  member: { id: string; label: string | null };
  rootKey: string;
  label: string;
  remote: string | null;
  reason: UncapturedReason;
  misses: number;
  /** What the machine holds of the repository's capture: `held`, `full` past its cap, or `expired` with age. */
  held: HeldState;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** `GET /api/uncaptured`. */
export interface UncapturedAnswer {
  items: UncapturedRootItem[];
}

/**
 * `GET /api/uncaptured`: the repositories machines could not capture, the most recently missed first. An administrator
 * reads every machine's, any other member their own machines' alone.
 */
export async function handleListUncaptured(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const rows = await listUncaptured(env.db, isAdmin(ctx.member.role) ? { all: true } : { all: false, memberId: ctx.member.id });
  const names = await ownMachineNames(env.db, ctx.member.id, ctx.now);
  const items = rows.map((row): UncapturedRootItem => ({
    machineId: row.machineId, machineName: names.get(row.machineId) ?? null, member: row.member, rootKey: row.rootKey, label: row.label,
    remote: row.remote, reason: isUncapturedReason(row.reason) ? row.reason : 'refused', misses: row.misses, held: isHeldState(row.held) ? row.held : 'held', firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
  }));
  return ok({ items } satisfies UncapturedAnswer);
}

/** What the connect takes: the project to join, or none for the one the remote names, or one created for it. */
export interface ConnectRequest {
  projectId?: string;
}

/** What the connect answers: the machine joins at a hook in the repository, within minutes. */
export interface ConnectAnswer {
  connected: true;
  machineId: string;
  rootKey: string;
  /** The project it will join; null where it joins what its remote names, or one created for it. */
  projectId: string | null;
}

export async function handleConnectUncaptured(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const machineId = ctx.params.machineId!;
  const rootKey = ctx.params.rootKey!;
  const admin = isAdmin(ctx.member.role);
  const row = await getUncaptured(env.db, machineId, rootKey);
  if (row === null || (!admin && row.member.id !== ctx.member.id)) return notFound();
  const body = ctx.request.headers.get('content-length') === '0' ? {} : await readJsonObject(ctx.request) ?? {};
  const projectId = body.projectId === undefined ? null : body.projectId;
  if (projectId !== null) {
    if (typeof projectId !== 'string') return badRequest('projectId must be a project id');
    const project = (await listVisibleProjects(env.db, ctx.member)).find((p) => p.projectId === projectId);
    if (project === undefined) return badRequest('projectId names no project that accepts capture');
    if (row.remote !== null) {
      const holder = await projectForRemote(env.db, row.remote);
      if (holder !== null && holder !== projectId) {
        return Response.json({ error: 'remote_bound', detail: 'this repository\'s remote already belongs to another project' }, { status: 409 });
      }
      if (holder === null) await recordProjectRemote(env.db, projectId, row.remote, ctx.now);
    }
  } else if (!(await mayCreateProjects(env.db, row.member.id))) {
    // The machine's own member creates the project when it joins; one who may not is answered here, not at the join.
    return badRequest('this Deployment creates projects only on the dashboard: name the project to connect it to');
  }
  const written = await connectMachineRoot(env.db, machineId, rootKey, projectId ?? '', ctx.member.id, ctx.now);
  if (!written.applied) return written.reason === 'absent' ? notFound() : badRequest(written.detail ?? 'the connection could not be recorded');
  // Connected: the machine joins at a hook in the repository, and "Needs you" has nothing more to ask.
  await clearUncapturedStatement(env.db, machineId, rootKey).run();
  emit({ kind: 'repository_connected', machineId, actor: ctx.member.id });
  return ok({ connected: true, machineId, rootKey, projectId } satisfies ConnectAnswer);
}
