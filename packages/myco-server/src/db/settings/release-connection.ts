import type { RelationalStore } from '../../core/adapters.js';
import { assertion, refusalCode, refused, write, type BindValue, type Bound } from '../index.js';
import { commitSecretChange } from './secret-writes.js';
const RELEASE_REVISION_CONFLICT = refusalCode('release_revision_conflict');
const unchanged = assertion<[string, string | null]>({
  name: 'settings.releaseUnchanged',
  refusal: RELEASE_REVISION_CONFLICT, when: `(SELECT revision FROM project_release_provenance WHERE project_id=?1) IS ?2`,
});
const insert = write<BindValue[], { revision: string }>({
  name: 'settings.insertReleaseSettings',
  sql: `INSERT INTO project_release_provenance (revision, enabled, github_repo, production_refs, integration_refs,
            package_map, include_unknown, max_lookups, secret_slot, updated_at, updated_by, check_requested_at, project_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING revision`,
});
const update = write<BindValue[], { revision: string }>({
  name: 'settings.updateReleaseSettings',
  sql: `UPDATE project_release_provenance SET revision = ?, enabled = ?, github_repo = ?, production_refs = ?, integration_refs = ?,
            package_map = ?, include_unknown = ?, max_lookups = ?, secret_slot = ?, updated_at = ?, updated_by = ?,
            work_generation = work_generation + 1, check_requested_at = ?
            WHERE project_id = ? AND revision = ? RETURNING revision`,
});
export interface ReleaseSettingsSave {
  project: string;
  previous: { revision: string; secretSlot: string | null } | null;
  values: BindValue[];
  slot: string | null;
  sealed: Bound | null;
  now: number;
  actor: string;
  /** The Project's due row after this save, committed with it. */
  due: Bound;
}

export async function saveReleaseSettings(db: RelationalStore, save: ReleaseSettingsSave): Promise<boolean> {
  const { project, previous, values, slot, sealed, now, actor, due } = save;
  try {
    await commitSecretChange(
      db,
      unchanged.bind(project, previous?.revision ?? null),
      [
        ...(sealed === null ? [] : [sealed]),
        previous === null ? insert.bind(...values, now, project) : update.bind(...values, now, project, previous.revision),
        due,
      ],
      previous?.secretSlot != null && previous.secretSlot !== slot ? { name: previous.secretSlot, actor, now } : null,
    );
    return true;
  } catch (error) {
    if (refused(error, RELEASE_REVISION_CONFLICT)) return false;
    throw error;
  }
}
