import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, refusalCode, refused, write, type Bound } from '../index.js';
const RELEASE_REVISION_CONFLICT = refusalCode('release_revision_conflict');
const unchanged = assertion<[project: string, revision: string | null]>({
  name: 'settings.releaseUnchanged',
  refusal: RELEASE_REVISION_CONFLICT, when: `(SELECT revision FROM project_release_provenance WHERE project_id=?1) IS ?2`,
});

/** The settings one save writes, in column order. */
export type ReleaseSettingsValues = [revision: string, enabled: number, productionRefs: string, integrationRefs: string,
  packageMap: string, includeUnknown: number, maxLookups: number, updatedAt: number, updatedBy: string];

const insert = write<[...ReleaseSettingsValues, requestedAt: number, project: string], { revision: string }>({
  name: 'settings.insertReleaseSettings',
  sql: `INSERT INTO project_release_provenance (revision, enabled, production_refs, integration_refs,
            package_map, include_unknown, max_lookups, updated_at, updated_by, check_requested_at, project_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING revision`,
});
const update = write<[...ReleaseSettingsValues, requestedAt: number, project: string, previous: string], { revision: string }>({
  name: 'settings.updateReleaseSettings',
  sql: `UPDATE project_release_provenance SET revision = ?1, enabled = ?2, production_refs = ?3, integration_refs = ?4,
            package_map = ?5, include_unknown = ?6, max_lookups = ?7, updated_at = ?8, updated_by = ?9,
            work_generation = work_generation + 1, check_requested_at = ?10
            WHERE project_id = ?11 AND revision = ?12 RETURNING revision`,
});
export interface ReleaseSettingsSave {
  project: string;
  previous: string | null;
  values: ReleaseSettingsValues;
  now: number;
  /** The Project's due row after this save, committed with it. */
  due: Bound;
}

export async function saveReleaseSettings(db: RelationalStore, save: ReleaseSettingsSave): Promise<boolean> {
  const { project, previous, values, now, due } = save;
  try {
    await commit(
      db,
      unchanged.bind(project, previous),
      previous === null ? insert.bind(...values, now, project) : update.bind(...values, now, project, previous),
      due,
    );
    return true;
  } catch (error) {
    if (refused(error, RELEASE_REVISION_CONFLICT)) return false;
    throw error;
  }
}
