import type { RelationalStore } from '../../core/adapters.js';
import { assertion, read, readSet, refusalCode, refused, write, type Bound } from '../index.js';
import { commitSecretChange } from '../settings/secret-writes.js';
export interface ConnectionRow {
  revision: string;
  url: string;
  branch: string;
  username: string | null;
  secretSlot: string | null;
  updatedAt: number;
  updatedBy: string;
}

const row = read<[string], ConnectionRow>({
  name: 'storage.repositoryConnection',
  sql: `
  SELECT revision,url,branch,username,secret_slot AS secretSlot,updated_at AS updatedAt,updated_by AS updatedBy
    FROM project_repositories WHERE project_id=?`,
});
const REPOSITORY_REVISION_CONFLICT = refusalCode('repository_revision_conflict');
const unchanged = assertion<[string, string | null]>({
  name: 'storage.repositoryUnchanged',
  refusal: REPOSITORY_REVISION_CONFLICT, when: `(SELECT revision FROM project_repositories WHERE project_id=?1) IS ?2`,
});
const put = write<[string, string, string, string, string | null, string | null, number, string], { revision: string }>({
  name: 'storage.putRepository',
  sql: `
  INSERT INTO project_repositories(project_id,revision,url,branch,username,secret_slot,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,url=excluded.url,branch=excluded.branch,
      username=excluded.username,secret_slot=excluded.secret_slot,updated_at=excluded.updated_at,updated_by=excluded.updated_by RETURNING revision`,
});
const remove = write<[string], { revision: string }>({
  name: 'storage.removeRepository',
  sql: 'DELETE FROM project_repositories WHERE project_id=? RETURNING revision',
});
export async function repositoryConnection(db: RelationalStore, projectId: string): Promise<ConnectionRow | null> {
  const [[current]] = await readSet(db, row.bind(projectId));
  return current ?? null;
}
export async function saveRepository(
  db: RelationalStore,
  projectId: string,
  previous: ConnectionRow | null,
  next: ConnectionRow,
  sealed: Bound | null,
): Promise<boolean> {
  return persist(
    db,
    unchanged.bind(projectId, previous?.revision ?? null),
    [
      ...(sealed === null ? [] : [sealed]),
      put.bind(projectId, next.revision, next.url, next.branch, next.username, next.secretSlot, next.updatedAt, next.updatedBy),
    ],
    previous?.secretSlot != null && previous.secretSlot !== next.secretSlot
      ? { name: previous.secretSlot, actor: next.updatedBy, now: next.updatedAt }
      : null,
  );
}
export async function removeRepository(
  db: RelationalStore,
  projectId: string,
  previous: ConnectionRow,
  actor: string,
  now: number,
): Promise<boolean> {
  return persist(
    db,
    unchanged.bind(projectId, previous.revision),
    [remove.bind(projectId)],
    previous.secretSlot === null ? null : { name: previous.secretSlot, actor, now },
  );
}
async function persist(
  db: RelationalStore,
  guard: Bound<unknown, 'assertion'>,
  writes: Bound[],
  retirement: { name: string; actor: string; now: number } | null,
): Promise<boolean> {
  try {
    await commitSecretChange(db, guard, writes, retirement);
    return true;
  } catch (error) {
    if (refused(error, REPOSITORY_REVISION_CONFLICT)) return false;
    throw error;
  }
}
