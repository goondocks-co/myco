import { reaching, type Reach, changing } from './schema-step.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * A wide owner's older pages leave the search for a record. A page marked `sealed` has its record ids in
 * `session_sealed_records`, each naming its page, so a placement opens only the pages that hold what it places
 * however many pages the owner has (`content/document-writer.ts`). Publications stopped for good are found through
 * their own index, for status. A session whose publication stands stopped on a fault that can clear is due again: the
 * publisher reads that stop as a fault to retry. A publication records the leading records already placed of a line
 * too wide for one commit, and the digest of what they hold, so the next pass places only the rest.
 */
export const V116_STATEMENTS: readonly string[] = [
  'ALTER TABLE session_pages ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS session_sealed_records (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    owner TEXT NOT NULL, k TEXT NOT NULL, record_id TEXT NOT NULL, page INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id, generation, owner, k, record_id)) WITHOUT ROWID`,
  'ALTER TABLE transcript_publication ADD COLUMN placed_records INTEGER',
  'ALTER TABLE transcript_publication ADD COLUMN placed_digest TEXT',
  `CREATE INDEX IF NOT EXISTS idx_transcript_publication_failed ON transcript_publication (project_id, failure) WHERE state = 'failed'`,
  `UPDATE session_documents SET due_at = 0 WHERE state = 'live' AND due_at IS NULL AND (project_id, session_id, generation) IN
    (SELECT project_id, session_id, generation FROM transcript_publication WHERE state = 'failed' AND failure IN ('blob_absent', 'receipt_absent'))`,
];

/** Why the step reaches tables earlier steps created. */
export const V116_REACHES: readonly Reach[] = [
  ...changing(['session_pages'], 'A page whose record ids the catalog holds leaves the search for a record, so placing into a wide owner stays bounded.'),
  ...changing(['transcript_publication'], 'A line too wide for one commit keeps the count of its records already placed, so every pass advances. A resumed line skips its placed records only while the derivation still holds what was placed. Status counts the publications stopped for good without reading the others.'),
  ...changing(['session_documents'], 'A quiet session whose publication stands stopped on a fault that can clear is due again, so the publisher reads that stop as a fault to retry.'),
];
