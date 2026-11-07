import type { RelationalStore } from '../../core/adapters.js';
import { assertion, write, type BindValue, type Bound } from '../index.js';
import { commitSecretChange } from './secret-writes.js';
const unchanged = assertion<[string, string | null]>({
  name: 'settings.releaseUnchanged',
  sql: `
  SELECT CASE WHEN (SELECT revision FROM project_release_provenance WHERE project_id=?1) IS ?2
    THEN 1 ELSE json_extract('[]','$[release_revision_conflict]') END`,
});
const insert = write<BindValue[], { revision: string }>({
  name: 'settings.insertReleaseSettings',
  sql: `INSERT OR IGNORE INTO project_release_provenance (revision, enabled, github_repo, production_refs, integration_refs,
            package_map, include_unknown, max_lookups, secret_slot, updated_at, updated_by, check_requested_at, project_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING revision`,
});
const update = write<BindValue[], { revision: string }>({
  name: 'settings.updateReleaseSettings',
  sql: `UPDATE project_release_provenance SET revision = ?, enabled = ?, github_repo = ?, production_refs = ?, integration_refs = ?,
            package_map = ?, include_unknown = ?, max_lookups = ?, secret_slot = ?, updated_at = ?, updated_by = ?,
            check_run_id = NULL, check_lease_until = NULL, check_requested_at = ?
            WHERE project_id = ? AND revision = ? RETURNING revision`,
});
export async function saveReleaseSettings(
  db: RelationalStore,
  project: string,
  previous: { revision: string; secretSlot: string | null } | null,
  values: BindValue[],
  slot: string | null,
  sealed: Bound | null,
  now: number,
  actor: string,
): Promise<boolean> {
  try {
    await commitSecretChange(
      db,
      unchanged.bind(project, previous?.revision ?? null),
      [
        ...(sealed === null ? [] : [sealed]),
        previous === null ? insert.bind(...values, now, project) : update.bind(...values, now, project, previous.revision),
      ],
      previous?.secretSlot != null && previous.secretSlot !== slot ? { name: previous.secretSlot, actor, now } : null,
    );
    return true;
  } catch (error) {
    if (conflict(error)) return false;
    throw error;
  }
}
function conflict(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('release_revision_conflict') || conflict(error.cause));
}
