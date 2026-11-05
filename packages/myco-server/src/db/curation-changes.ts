/** Pending source stamps accumulate independently of the active discovery pass. */
export const curationChangeSql = (project: string, stamp: string, condition = '1'): string => `INSERT INTO spore_curation_changes(project_id,revision,dirty,pending_at)
  SELECT ${project},1,1,${stamp} WHERE ${condition} ON CONFLICT(project_id) DO UPDATE SET revision=revision+1,dirty=1,
  pending_at=CASE WHEN pending_at IS NULL THEN excluded.pending_at ELSE MIN(pending_at,excluded.pending_at) END;`;
