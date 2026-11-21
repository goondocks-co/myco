import { write } from '../index.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * A spore a curation answer wrote is dated by when it was written: its `created_at` is the answer's own write time,
 * retained on the operation, while its sources' observation stays in `observed_at`. Answers record that time on every
 * spore they write; this re-dates, a page of operation outputs at a time, the ones an earlier release dated by their
 * sources. Each page reads its outputs' operations and spores alone, and moves a spore only when its date differs.
 */
const PROJECTION = 'spore_written_at';
const PHASE = 'answerOutputs';
const KEYS = jsonKeys(['project_id', 'unit_id', 'spore_id']);
/** The page's operation `u`, an answer that recorded a write time. */
const ANSWER_OF_KEY = `CROSS JOIN spore_curation_units u ON u.project_id=key.project_id AND u.id=key.unit_id
  AND u.kind='answer' AND u.unavailable IS NULL AND u.created_at>0`;

export const SPORE_WRITTEN_AT_CATCHUP = {
  projection: PROJECTION,
  phases: { [PHASE]: {
    source: { table: 'spore_curation_unit_members', columns: ['project_id', 'unit_id', 'spore_id'], where: "role='output'", unique: true },
    reconcile: [write<[string]>({ name: 'sporeWrittenAt.page', sql: `UPDATE spores SET created_at=(SELECT u.created_at FROM (${KEYS}) key ${ANSWER_OF_KEY}
        WHERE key.project_id=spores.project_id AND key.spore_id=spores.id)
      WHERE rowid IN (SELECT s.rowid FROM (${KEYS}) key ${ANSWER_OF_KEY}
        CROSS JOIN spores s ON s.project_id=key.project_id AND s.id=key.spore_id WHERE s.created_at<>u.created_at)` })],
  } },
} as const satisfies CatchupFamily;

/** The catch-up row a schema step seeds: done at once on a Deployment holding no operation output. */
export const SPORE_WRITTEN_AT_SEED = `INSERT INTO projection_catchup(projection,phase,done) SELECT '${PROJECTION}','${PHASE}',
  NOT EXISTS(SELECT 1 FROM spore_curation_unit_members INDEXED BY idx_curation_unit_output WHERE role='output') ON CONFLICT DO NOTHING`;
