import { EMBEDDING_SOURCES, newReleaseRecordRevision, newSourceRevision } from './schema-v20.js';

/** The columns of a release state row an embedded record's vector depends on: which record it names, and the state and confidence its metadata carries. */
export const RELEASE_REVISION_COLUMNS = 'project_id, namespace, record_id, state, confidence';

/** True when any of the comma-separated columns holds a different value after the update, NULL included. */
const anyChanged = (columns: string): string => columns.split(',').map((c) => c.trim()).map((c) => `old.${c} IS NOT new.${c}`).join(' OR ');

/**
 * Schema v49: a record's embedding revision changes only when a value its
 * vector is built from changes (#1430).
 *
 * Each source table's update trigger, and the release state update trigger,
 * fire only when a column they follow holds a different value afterwards. An
 * UPDATE that names a column and writes back the value it held (a replayed
 * `session.start`, an out-of-order plan event, a release check that records
 * new refs under the same state and confidence) leaves the revision, and so
 * the stored vector, as it is.
 */
export const V49_STATEMENTS: readonly string[] = [
  ...EMBEDDING_SOURCES.flatMap((s) => [
    `DROP TRIGGER IF EXISTS ${s.table}_embedding_au`,
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_au AFTER UPDATE OF ${s.columns} ON ${s.table}
     WHEN ${anyChanged(s.columns)} BEGIN
      ${newSourceRevision(s)} END`,
  ]),
  `DROP TRIGGER IF EXISTS knowledge_release_embedding_update`,
  `CREATE TRIGGER IF NOT EXISTS knowledge_release_embedding_update AFTER UPDATE OF ${RELEASE_REVISION_COLUMNS} ON knowledge_release_state
     WHEN ${anyChanged(RELEASE_REVISION_COLUMNS)} BEGIN
      ${newReleaseRecordRevision('old')}
${newReleaseRecordRevision('new')} END`,
];
