import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_PUBLICATION_MARK } from './schema-vNEXT-publication-mark.js';

/** Every published document revision moves the sessions heartbeat mark in the same transaction. */
export const PUBLICATION_MARK_STEPS: readonly SchemaStep[] = [{
  version: NEXT_PUBLICATION_MARK,
  statements: [
    "INSERT INTO change_marks(kind,revision) VALUES('sessions',0) ON CONFLICT DO NOTHING",
    `CREATE TRIGGER IF NOT EXISTS publication_revision_mark AFTER UPDATE OF published_revision ON session_documents
      WHEN OLD.published_revision IS NOT NEW.published_revision BEGIN
      UPDATE change_marks SET revision=revision+1 WHERE kind='sessions'; END`,
  ],
  reaches: [
    ...changing(['change_marks'], 'A monotonic sessions revision records document publication independently of capture receipt times.'),
    ...reaching(['session_documents'], 'Published revisions move the heartbeat mark through their existing writer.'),
  ],
}];
