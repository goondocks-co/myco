import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, readSet, refusalCode, refused, write } from '../index.js';
import { releaseDueAfterConnectionChange } from '../release/due.js';

/** A Project's repository: one GitHub repository reached through one App installation, both named by GitHub's ids. */
export interface ConnectionRow {
  revision: string;
  url: string;
  branch: string;
  repositoryId: number;
  installationId: number;
  updatedAt: number;
  updatedBy: string;
}

const row = read<[project: string], ConnectionRow>({
  name: 'storage.repositoryConnection',
  sql: `
  SELECT revision,url,branch,github_repository_id AS repositoryId,github_installation_id AS installationId,updated_at AS updatedAt,updated_by AS updatedBy
    FROM project_repositories WHERE project_id=?1`,
});
const REPOSITORY_REVISION_CONFLICT = refusalCode('repository_revision_conflict');
const unchanged = assertion<[project: string, revision: string | null]>({
  name: 'storage.repositoryUnchanged',
  refusal: REPOSITORY_REVISION_CONFLICT, when: `(SELECT revision FROM project_repositories WHERE project_id=?1) IS ?2`,
});
const put = write<[project: string, revision: string, url: string, branch: string, repository: number, installation: number, at: number, by: string], { revision: string }>({
  name: 'storage.putRepository',
  sql: `
  INSERT INTO project_repositories(project_id,revision,url,branch,github_repository_id,github_installation_id,updated_at,updated_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
    ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,url=excluded.url,branch=excluded.branch,
      github_repository_id=excluded.github_repository_id,github_installation_id=excluded.github_installation_id,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by RETURNING revision`,
});
const remove = write<[project: string], { revision: string }>({
  name: 'storage.removeRepository',
  sql: 'DELETE FROM project_repositories WHERE project_id=?1 RETURNING revision',
});

export async function repositoryConnection(db: RelationalStore, projectId: string): Promise<ConnectionRow | null> {
  const [[current]] = await readSet(db, row.bind(projectId));
  return current ?? null;
}

/**
 * Write or remove a connection only over the revision the caller read. A release check in flight for the Project ends
 * in the same commit, so none publishes what it read from the previous repository. Answers false when the revision moved.
 */
async function change(db: RelationalStore, projectId: string, previous: string | null, write: ReturnType<typeof put.bind> | ReturnType<typeof remove.bind>): Promise<boolean> {
  try {
    await commit(db, unchanged.bind(projectId, previous), write, releaseDueAfterConnectionChange(projectId));
    return true;
  } catch (error) {
    if (refused(error, REPOSITORY_REVISION_CONFLICT)) return false;
    throw error;
  }
}

export const saveRepository = (db: RelationalStore, projectId: string, previous: string | null, next: ConnectionRow): Promise<boolean> =>
  change(db, projectId, previous, put.bind(projectId, next.revision, next.url, next.branch, next.repositoryId, next.installationId, next.updatedAt, next.updatedBy));

export const removeRepository = (db: RelationalStore, projectId: string, previous: string): Promise<boolean> =>
  change(db, projectId, previous, remove.bind(projectId));
