/** Git remotes as Project names: which Project a remote names, and binding a remote the first time it is seen. */
import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows, write } from '../index.js';

const holderId = read<[remote: string], { projectId: string }>({ name: 'storage.remoteProject', sql:
  'SELECT project_id AS projectId FROM project_remotes WHERE remote = ?1' });
const holder = read<[remote: string], { projectId: string; archivedAt: number | null }>({ name: 'storage.remoteHolder', sql:
  `SELECT p.project_id AS projectId, p.archived_at AS archivedAt
    FROM projects p WHERE p.project_id = (SELECT r.project_id FROM project_remotes r WHERE r.remote = ?1)` });
const bind = write<[remote: string, project: string, now: number], { remote: string }>({ name: 'storage.bindRemote', sql:
  'INSERT OR IGNORE INTO project_remotes (remote, project_id, first_seen_at) VALUES (?1, ?2, ?3) RETURNING remote' });

/** The Project a remote names, or null where no Project has claimed it. */
export async function remoteProjectId(db: RelationalStore, remote: string): Promise<string | null> {
  return (await first(db, holderId.bind(remote)))?.projectId ?? null;
}

/** The Project a remote names with its archive stamp, or null where no Project has claimed the remote. */
export const remoteHolderRow = (db: RelationalStore, remote: string) => first(db, holder.bind(remote));

/** Binds the remote to the Project unless another already holds it; answers whether this call bound it. */
export async function bindRemote(db: RelationalStore, remote: string, projectId: string, now: number): Promise<boolean> {
  return (await rows(db, bind.bind(remote, projectId, now))).length === 1;
}
