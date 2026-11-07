/** A cluster's first claim owns its daily allowance independently of later attempts. */
export const V700_STATEMENTS: readonly string[] = [
  'ALTER TABLE spore_curation_work ADD COLUMN first_started_at INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_curation_first_started ON spore_curation_work(project_id,first_started_at) WHERE first_started_at IS NOT NULL',
  `UPDATE spore_curation_work AS w SET first_started_at=firsts.started_at FROM
    (SELECT project_id,subject,MIN(started_at) AS started_at FROM agent_runs WHERE task='curate-spores' AND started_at IS NOT NULL GROUP BY project_id,subject) AS firsts
    WHERE firsts.project_id=w.project_id AND firsts.subject='curation:'||w.project_id||':'||w.cluster_key`,
];
