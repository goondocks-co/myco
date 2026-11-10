import { reaching, type Reach, changing } from './schema-step.js';
/** A cluster's first claim owns its daily allowance independently of later attempts. */
export const V700_STATEMENTS: readonly string[] = [
  'ALTER TABLE spore_curation_work ADD COLUMN first_started_at INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_curation_first_started ON spore_curation_work(project_id,first_started_at) WHERE first_started_at IS NOT NULL',
  `UPDATE spore_curation_work AS w SET first_started_at=firsts.started_at FROM
    (SELECT project_id,subject,MIN(started_at) AS started_at FROM agent_runs WHERE task='curate-spores' AND started_at IS NOT NULL GROUP BY project_id,subject) AS firsts
    WHERE firsts.project_id=w.project_id AND firsts.subject='curation:'||w.project_id||':'||w.cluster_key`,
];

/** Why the step reaches tables earlier steps created. */
export const V700_REACHES: readonly Reach[] = changing(['spore_curation_work'], 'A cluster retains the time of its first admitted attempt across retries. Daily admission counts a bounded indexed window of first cluster attempts. Existing clusters retain their first start through their canonical run subjects.');
