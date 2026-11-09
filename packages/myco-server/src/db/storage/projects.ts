import { commit, assertion, read, readSet, refusalCode, refusalDetail, write } from '../index.js';
import { leafOffChecks, settingTexts } from '../../core/settings.js';
import type { RelationalStore } from '../../core/adapters.js';
import { MAX_PROJECTS } from '../../constants.js';
import { emit } from '../../telemetry.js';

export const PROJECT_NAME_MAX = 200;
const AUTO_CREATE_LEAF = 'capture.auto_create_projects';
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
export type ProjectCreator = { kind: 'member'; memberId: string } | { kind: 'operator' };
type ProjectAdmission =
  | { resolved: true; projectId: string; name: string; created: boolean; archived: boolean }
  | { resolved: false; reason: 'invalid_field' | 'auto_create_off' | 'refused' };

const autoCreate = leafOffChecks(AUTO_CREATE_LEAF, JSON.stringify(false)).admission;
const POLICY = `(? IS NULL OR EXISTS (SELECT 1 FROM members creator WHERE creator.id=? AND creator.revoked_at IS NULL
  AND (creator.role='admin' OR (creator.role='member' AND ${autoCreate.sql}))))`;
const ACTIVE_PROJECTS = '(SELECT active FROM active_project_count WHERE slot=1)';
const CAPACITY = `${ACTIVE_PROJECTS} < ${MAX_PROJECTS}`;
const allowed = read<Array<string | null>, { allowed: number }>({
  name: 'storage.projectCreationAllowed',
  sql: `SELECT ${POLICY} AS allowed`,
});
const insert = write<Array<string | number | null>, { project_id: string }>({
  name: 'storage.createProject',
  sql: `
  INSERT OR IGNORE INTO projects(project_id,name,created_at)
    SELECT ?,?,? WHERE ?=1 AND ${POLICY} AND ${CAPACITY}
    AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM project_remotes WHERE remote=?)) RETURNING project_id`,
});
const remoteBind = write<[string | null, string, number]>({
  name: 'storage.bindProjectRemote',
  sql: `
  INSERT OR IGNORE INTO project_remotes(remote,project_id,first_seen_at)
    SELECT ?1,?2,?3 WHERE ?1 IS NOT NULL
      AND EXISTS(SELECT 1 FROM projects WHERE project_id=?2 AND created_at=?3)
      AND NOT EXISTS(SELECT 1 FROM project_remotes WHERE project_id=?2)`,
});
const held = read<[string, string | null], { projectId: string; name: string; archivedAt: number | null }>({
  name: 'storage.createdProject',
  sql: `
  SELECT project_id AS projectId,name,archived_at AS archivedAt FROM projects
  WHERE project_id=CASE WHEN ?2 IS NULL THEN ?1 ELSE (SELECT project_id FROM project_remotes WHERE remote=?2) END`,
});
const PROJECT_LIMIT = refusalCode('project_limit');
const restoreCapacity = assertion<[string]>({
  name: 'storage.projectRestoreCapacity',
  refusal: PROJECT_LIMIT,
  detail: ACTIVE_PROJECTS,
  when: `NOT EXISTS(SELECT 1 FROM projects WHERE project_id=? AND archived_at IS NOT NULL)
    OR ${CAPACITY}`,
});
const restore = write<[string], { project_id: string }>({
  name: 'storage.unarchiveProject',
  sql: `
  UPDATE projects SET archived_at=NULL,archived_by=NULL WHERE project_id=? AND archived_at IS NOT NULL RETURNING project_id`,
});
const exists = read<[string], { project_id: string }>({
  name: 'storage.projectExistsForRestore',
  sql: 'SELECT project_id FROM projects WHERE project_id=?',
});
type UnarchiveOutcome = 'restored' | 'absent' | 'not_archived'
  | { reason: 'project_limit'; active: number; limit: number };
export async function unarchiveProject(db: RelationalStore, projectId: string): Promise<UnarchiveOutcome> {
  try {
    const [, restored, present] = await commit(db, restoreCapacity.bind(projectId), restore.bind(projectId), exists.bind(projectId));
    return restored.results.length === 1 ? 'restored' : present.results.length === 1 ? 'not_archived' : 'absent';
  } catch (error) {
    const active = capacityFailure(error);
    if (active !== null) return { reason: 'project_limit', active, limit: MAX_PROJECTS };
    throw error;
  }
}
function capacityFailure(error: unknown): number | null {
  const active = refusalDetail(error, PROJECT_LIMIT);
  return active === null ? null : Number(active);
}

export async function autoCreateProjects(db: RelationalStore): Promise<boolean> {
  return (await settingTexts(db, [AUTO_CREATE_LEAF])).get(AUTO_CREATE_LEAF) !== JSON.stringify(false);
}

export async function mayCreateProjects(db: RelationalStore, memberId: string): Promise<boolean> {
  const [[result]] = await readSet(db, allowed.bind(memberId, memberId, ...autoCreate.params));
  return result?.allowed === 1;
}

/** Every Project creator commits the current actor policy, ceiling and optional remote binding together. */
export async function admitProject(
  db: RelationalStore,
  request: {
    projectId: string;
    name: string;
    now: number;
    remote?: string | null;
    allowCreate?: boolean;
  },
  actor: ProjectCreator,
): Promise<ProjectAdmission> {
  const { projectId, now } = request;
  const name = request.name.trim();
  if (!PROJECT_ID.test(projectId) || projectId === '.' || projectId === '..' || name.length === 0 || name.length > PROJECT_NAME_MAX)
    return { resolved: false, reason: 'invalid_field' };
  const remote = request.remote ?? null;
  const actorId = actor.kind === 'operator' ? null : actor.memberId;
  const [created, , found, permission] = await commit(
    db,
    insert.bind(projectId, name, now, request.allowCreate === false ? 0 : 1, actorId, actorId, ...autoCreate.params, remote, remote),
    remoteBind.bind(remote, projectId, now),
    held.bind(projectId, remote),
    allowed.bind(actorId, actorId, ...autoCreate.params),
  );
  if (created.results.length === 1)
    emit({ kind: 'project_created', projectId, actor: actor.kind === 'member' ? actor.memberId : 'operator' });
  const row = found.results[0] as { projectId: string; name: string; archivedAt: number | null } | undefined;
  if (row !== undefined)
    return {
      resolved: true,
      projectId: row.projectId,
      name: row.name,
      archived: row.archivedAt !== null,
      created: created.results.length === 1,
    };
  return { resolved: false, reason: request.allowCreate === false || permission.results[0]!.allowed !== 1 ? 'auto_create_off' : 'refused' };
}

/** Explicit Project creation returns whether this operation inserted its identity. */
export async function createProject(
  db: RelationalStore,
  projectId: string,
  name: string,
  now: number,
  actor: ProjectCreator = { kind: 'operator' },
): Promise<boolean> {
  const result = await admitProject(db, { projectId, name, now }, actor);
  return result.resolved && result.created;
}
