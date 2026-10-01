/**
 * A member's own view of the Deployment's projects, over the CLI credential (#1499).
 *
 * `myco member join`, run inside a repository, connects that folder to a project on the member's Deployment: it lists
 * the projects to pick one, or creates one named for the folder. Both are credential-scoped member routes, answered to
 * any live member.
 *
 * Creating a project is not new authority. A member's capture already creates the project its header names the first
 * time the Deployment sees it (`ingest/projects.ts` `resolveProject`), under the same `MAX_PROJECTS` ceiling; this
 * route makes that creation explicit and named, so the dashboard shows the project before its first session.
 * Renaming, archiving and every other change to a project stay with an admin on the dashboard.
 */
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import type { CredentialContext } from '../context.js';
import { emptyBodyRoute } from '../auth/members.js';
import { MAX_PROJECTS } from '../constants.js';
import { HELD_STATES, type HeldState } from '@goondocks/myco-shared/member-protocol';
import { createNamedProject } from '../ingest/projects.js';
import { MAX_REMOTE_CHARS, normalizeRemote, resolveRepository } from '../core/remotes.js';
import { connectedRoot, connectMachineRoot, disconnectMachineRoot } from '../core/machine-settings.js';
import { leafValues, ROOT_KEY } from '../core/settings.js';
import { clearUncapturedStatement, heldUncapturedStatement, isUncapturedReason, recordUncapturedStatement, type UncapturedReason } from '../ingest/uncaptured.js';
import { isLiveAdmin } from '../auth/members-admin.js';
import { listVisibleProjects, ok, parseJsonObject } from './scope.js';
import { emit } from '../telemetry.js';

/** The longest name a project carries, as the dashboard's own rename admits. */
export const PROJECT_NAME_MAX = 200;

/** A fresh project id in the `proj_<32 hex>` form every project a machine has named uses. */
const freshProjectId = (): string => `proj_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** `POST /members/projects/list`: every project that accepts capture, newest activity first, with its session count. */
export const handleMemberProjectList = emptyBodyRoute(async (env: ServerEnv, ctx: CredentialContext) => {
  const projects = await listVisibleProjects(env.db, { id: ctx.memberId });
  return ok({ persisted: true, projects: projects.map((p) => ({ projectId: p.projectId, name: p.name, sessionCount: p.sessionCount, lastActivityAt: p.lastActivityAt })) });
});

/**
 * `POST /members/projects` with `{ name }`: create a project for the member to connect a folder to, under the same
 * ceiling capture creates projects under. Answers the new project's id; a Deployment at its ceiling creates nothing and
 * says so.
 */
export async function handleCreateMemberProject(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > PROJECT_NAME_MAX) return ok({ persisted: false, code: 'invalid_field', reason: `name is required, at most ${PROJECT_NAME_MAX} characters` });
  if (!(await mayCreateProjects(env.db, ctx.memberId))) return ok({ persisted: false, code: 'auto_create_off', reason: 'this Deployment creates projects only on the dashboard; an admin connects this repository' });
  const projectId = freshProjectId();
  if (!(await createNamedProject(env.db, projectId, name, ctx.now))) return ok({ persisted: false, code: 'refused', reason: `this Deployment already holds ${MAX_PROJECTS} projects; an admin can archive one from the dashboard` });
  emit({ kind: 'project_created', projectId, actor: ctx.memberId });
  return ok({ persisted: true, projectId, name });
}

/** The Deployment leaf that lets a member's machine create a project for a repository no project holds. */
export const AUTO_CREATE_LEAF = 'capture.auto_create_projects';
/** The longest folder name a repository is reported under. */
const LABEL_MAX = 128;
/** A folder name: no path separator and no control character. */
const LABEL = /^[^/\\\p{Cc}]{1,128}$/u;

/** Whether this Deployment lets a member's machine create projects; on unless an admin turned it off. */
export async function autoCreateProjects(db: RelationalStore): Promise<boolean> {
  return (await leafValues(db, [AUTO_CREATE_LEAF])).get(AUTO_CREATE_LEAF) !== JSON.stringify(false);
}

/** Whether `memberId` may create a project from a machine: an admin always, any other member while the switch is on. */
export async function mayCreateProjects(db: RelationalStore, memberId: string): Promise<boolean> {
  return await autoCreateProjects(db) || await isLiveAdmin(db, memberId);
}

/** A repository as a member's machine names it: its key, its folder name, and its remote where it has one. */
/** The most sessions one report counts. */
const SESSIONS_MAX = 10_000;

/**
 * A repository as a member's machine names it: its key, its folder name, and its remote where it has one; and, from a
 * machine that says so, what it holds of the repository's capture and how many sessions met it after its last report.
 * A machine that says neither holds the capture and counts one session.
 */
function repositoryOf(body: Record<string, unknown> | null): { rootKey: string; label: string; remote: string | null; held: HeldState; sessions: number } | string {
  const rootKey = typeof body?.rootKey === 'string' ? body.rootKey : '';
  if (!ROOT_KEY.test(rootKey)) return 'rootKey must be a repository key';
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  if (label.length === 0 || label.length > LABEL_MAX || !LABEL.test(label)) return `label must be a folder name of at most ${LABEL_MAX} characters`;
  if (body?.remote !== undefined && (typeof body.remote !== 'string' || body.remote.length > MAX_REMOTE_CHARS)) return `remote must be at most ${MAX_REMOTE_CHARS} characters`;
  const held = body?.held ?? 'held';
  if (!(HELD_STATES as readonly unknown[]).includes(held)) return 'held must be held, full or expired';
  const sessions = body?.sessions ?? 1;
  if (typeof sessions !== 'number' || !Number.isInteger(sessions) || sessions < 0 || sessions > SESSIONS_MAX) return `sessions must be a whole number from 0 to ${SESSIONS_MAX}`;
  return { rootKey, label, remote: typeof body?.remote === 'string' ? body.remote : null, held: held as HeldState, sessions };
}

/** What `POST /members/projects/resolve` answers. */
export type RepositoryAnswer =
  | { persisted: true; projectId: string; name: string; created: boolean }
  | { persisted: false; code: UncapturedReason | 'invalid_field'; reason: string };

/**
 * `POST /members/projects/resolve` with `{ rootKey, label, remote? }`: the project a repository on the member's machine
 * joins. A repository the machine is told to connect joins what it is told; any other joins the project its remote
 * names, or one created for it under its folder name while this Deployment lets machines create projects. A repository
 * with no remote joins only when it is told to. A repository that joins is no longer reported; one that cannot is
 * reported for "Needs you", with why.
 */
export async function handleResolveMemberProject(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  const repository = repositoryOf(parseJsonObject(ctx.body));
  if (typeof repository === 'string') return ok({ persisted: false, code: 'invalid_field', reason: repository } satisfies RepositoryAnswer);
  const { rootKey, label } = repository;
  const miss = async (reason: UncapturedReason, detail: string): Promise<Response> => {
    await recordUncapturedStatement(env.db, { machineId: ctx.machineId, memberId: ctx.memberId, rootKey, label, remote, reason, held: repository.held, sessions: repository.sessions, now: ctx.now }).run();
    return ok({ persisted: false, code: reason, reason: detail } satisfies RepositoryAnswer);
  };
  const remote = repository.remote === null ? null : normalizeRemote(repository.remote);
  const told = await connectedRoot(env.db, ctx.machineId, rootKey);
  if (told !== null && told !== '') {
    const [project] = (await listVisibleProjects(env.db, { id: ctx.memberId })).filter((p) => p.projectId === told);
    if (project === undefined) return miss('archived', 'the project this repository was connected to no longer accepts capture');
    await clearUncapturedStatement(env.db, ctx.machineId, rootKey).run();
    return ok({ persisted: true, projectId: project.projectId, name: project.name, created: false } satisfies RepositoryAnswer);
  }
  if (remote === null && told === null) return miss('no_remote', 'a repository with no remote joins only when it is connected from "Needs you"');
  const resolved = await resolveRepository(env.db, {
    remote, name: label, allowCreate: await mayCreateProjects(env.db, ctx.memberId), projectId: freshProjectId(), now: ctx.now, maxProjects: MAX_PROJECTS,
  });
  if (!resolved.resolved) {
    const detail = resolved.reason === 'auto_create_off' ? 'this Deployment creates projects only on the dashboard; an admin connects this repository'
      : resolved.reason === 'archived' ? 'the project this repository belongs to is archived'
      : `this Deployment already holds ${MAX_PROJECTS} projects; an admin can archive one from the dashboard`;
    return miss(resolved.reason, detail);
  }
  // A repository with no remote keeps the project it is given, so its next resolve joins the same one.
  if (remote === null) await connectMachineRoot(env.db, ctx.machineId, rootKey, resolved.projectId, ctx.memberId, ctx.now);
  await clearUncapturedStatement(env.db, ctx.machineId, rootKey).run();
  if (resolved.created) emit({ kind: 'project_created', projectId: resolved.projectId, actor: ctx.memberId });
  return ok({ persisted: true, projectId: resolved.projectId, name: resolved.name, created: resolved.created } satisfies RepositoryAnswer);
}

/**
 * `POST /members/uncaptured` with `{ rootKey, label, remote?, reason }`: a repository the member's machine met and will
 * not join on its own, for "Needs you": outside the folders it captures, or with no remote.
 */
export async function handleReportUncaptured(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  const repository = repositoryOf(body);
  if (typeof repository === 'string') return ok({ persisted: false, code: 'invalid_field', reason: repository });
  const reason = body?.reason;
  if (!isUncapturedReason(reason) || (reason !== 'outside_folders' && reason !== 'no_remote')) {
    return ok({ persisted: false, code: 'invalid_field', reason: 'reason must be outside_folders or no_remote' });
  }
  const remote = repository.remote === null ? null : normalizeRemote(repository.remote);
  const written = await recordUncapturedStatement(env.db, { machineId: ctx.machineId, memberId: ctx.memberId, rootKey: repository.rootKey, label: repository.label, remote, reason, held: repository.held, sessions: repository.sessions, now: ctx.now }).run();
  return ok({ persisted: written.meta.changes > 0 });
}

/**
 * `POST /members/uncaptured/state` with `{ rootKey, state }`: what became of a repository the machine reported.
 * `connected` forgets it, as a `myco member join` there connected it; `left` forgets it and stops telling the machine
 * to connect it, as `myco member leave` opted it out; `full` and `expired` record that the machine no longer holds its
 * capture. A repository the machine never reported changes nothing.
 */
export async function handleUncapturedState(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  const rootKey = typeof body?.rootKey === 'string' ? body.rootKey : '';
  if (!ROOT_KEY.test(rootKey)) return ok({ persisted: false, code: 'invalid_field', reason: 'rootKey must be a repository key' });
  const state = body?.state;
  if (state !== 'connected' && state !== 'left' && state !== 'full' && state !== 'expired') {
    return ok({ persisted: false, code: 'invalid_field', reason: 'state must be connected, left, full or expired' });
  }
  if (state === 'left') {
    // Left on the machine: nothing is asked of "Needs you", and the machine is no longer told to connect it.
    const [cleared, untold] = [await clearUncapturedStatement(env.db, ctx.machineId, rootKey).run(), await disconnectMachineRoot(env.db, ctx.machineId, rootKey, ctx.memberId, ctx.now)];
    return ok({ persisted: cleared.meta.changes > 0 || untold });
  }
  const written = state === 'connected'
    ? await clearUncapturedStatement(env.db, ctx.machineId, rootKey).run()
    : await heldUncapturedStatement(env.db, ctx.machineId, rootKey, state).run();
  return ok({ persisted: written.meta.changes > 0 });
}
