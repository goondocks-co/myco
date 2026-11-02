import { leafOffChecks, settingTexts } from './settings.js';
import type { RelationalStore } from './adapters.js';
import { MAX_PROJECTS } from '../constants.js';
import { emit } from '../telemetry.js';

export const PROJECT_NAME_MAX = 200;
export const AUTO_CREATE_LEAF = 'capture.auto_create_projects';
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
export type ProjectCreator = { kind: 'member'; memberId: string } | { kind: 'operator' };
export type ProjectAdmission = { resolved: true; projectId: string; name: string; created: boolean; archived: boolean }
  | { resolved: false; reason: 'invalid_field' | 'auto_create_off' | 'refused' };

function projectCreationPolicy(actor: ProjectCreator): { sql: string; params: string[] } {
  const autoCreate = leafOffChecks(AUTO_CREATE_LEAF, JSON.stringify(false)).admission;
  return actor.kind === 'operator' ? { sql: '1', params: [] } : {
    sql: `EXISTS (SELECT 1 FROM members creator WHERE creator.id = ? AND creator.revoked_at IS NULL
      AND (creator.role = 'admin' OR (creator.role = 'member' AND ${autoCreate.sql})))`,
    params: [actor.memberId, ...autoCreate.params],
  };
}

export async function autoCreateProjects(db: RelationalStore): Promise<boolean> {
  return (await settingTexts(db, [AUTO_CREATE_LEAF])).get(AUTO_CREATE_LEAF) !== JSON.stringify(false);
}

export async function mayCreateProjects(db: RelationalStore, memberId: string): Promise<boolean> {
  const policy = projectCreationPolicy({ kind: 'member', memberId });
  return (await db.prepare(`SELECT ${policy.sql} AS allowed`).bind(...policy.params).first<{ allowed: number }>())?.allowed === 1;
}

/** Every Project creator commits the current actor policy, ceiling and optional remote binding together. */
export async function admitProject(db: RelationalStore, request: {
  projectId: string; name: string; now: number; remote?: string | null; allowCreate?: boolean;
}, actor: ProjectCreator): Promise<ProjectAdmission> {
  const { projectId, now } = request;
  const name = request.name.trim();
  if (!PROJECT_ID.test(projectId) || projectId === '.' || projectId === '..' || name.length === 0 || name.length > PROJECT_NAME_MAX) return { resolved: false, reason: 'invalid_field' };
  const remote = request.remote ?? null;
  const { sql: policy, params: policyParams } = projectCreationPolicy(actor);
  const lookup = remote === null ? 'p.project_id = ?' : 'p.project_id = (SELECT project_id FROM project_remotes WHERE remote = ?)';
  const [created, , held, allowed] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO projects(project_id,name,created_at)
      SELECT ?,?,? WHERE ? = 1 AND ${policy}
        AND (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL) < ?
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM project_remotes WHERE remote = ?))`)
      .bind(projectId, name, now, request.allowCreate === false ? 0 : 1, ...policyParams, MAX_PROJECTS, remote, remote),
    db.prepare(`INSERT OR IGNORE INTO project_remotes(remote,project_id,first_seen_at)
      SELECT ?,?,? WHERE ? IS NOT NULL AND changes() = 1`).bind(remote, projectId, now, remote),
    db.prepare(`SELECT p.project_id AS projectId,p.name,p.archived_at AS archivedAt FROM projects p WHERE ${lookup}`).bind(remote ?? projectId),
    db.prepare(`SELECT ${policy} AS allowed`).bind(...policyParams),
  ]);
  if (created!.meta.changes === 1) emit({ kind: 'project_created', projectId, actor: actor.kind === 'member' ? actor.memberId : 'operator' });
  const row = held!.results[0] as { projectId: string; name: string; archivedAt: number | null } | undefined;
  if (row !== undefined) return { resolved: true, projectId: row.projectId, name: row.name, archived: row.archivedAt !== null, created: created!.meta.changes === 1 };
  return { resolved: false, reason: request.allowCreate === false || (allowed!.results[0] as { allowed: number }).allowed !== 1 ? 'auto_create_off' : 'refused' };
}

/** Explicit Project creation returns whether this operation inserted its identity. */
export async function createProject(db: RelationalStore, projectId: string, name: string, now: number, actor: ProjectCreator = { kind: 'operator' }): Promise<boolean> {
  const result = await admitProject(db, { projectId, name, now }, actor);
  return result.resolved && result.created;
}
