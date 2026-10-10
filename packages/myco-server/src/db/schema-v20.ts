import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { EMBEDDING_SOURCES, embeddingSourcesView, type Source } from './embedding-sources.js';
export { EMBEDDING_SOURCES, embeddingSourcesView, SOURCES_WITH_PRESENTED_SESSION_DATE } from './embedding-sources.js';

/** The trigger body that gives a source row a new embedding revision, read from `new`. */
export const newSourceRevision = (s: Source): string => `INSERT INTO embedding_versions(project_id, type, record_id, revision) VALUES(new.project_id, '${s.type}', new.${s.id}, lower(hex(randomblob(16))))
      ON CONFLICT(project_id, type, record_id) DO UPDATE SET revision = excluded.revision;`;

/** The trigger statement that gives the record a release state row names (through `old` or `new`) a new embedding revision. */
export const newReleaseRecordRevision = (row: 'old' | 'new'): string => `UPDATE embedding_versions SET revision = lower(hex(randomblob(16))) WHERE project_id = ${row}.project_id AND record_id = ${row}.record_id
      AND (${EMBEDDING_SOURCES.map((s) => `(${row}.namespace = '${s.table}' AND type = '${s.type}')`).join(' OR ')});`;

/** Source mutations invalidate vectors atomically; provider calls occur only during reconciliation. */
export const V20_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS embedding_versions (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), type TEXT NOT NULL, record_id TEXT NOT NULL,
    revision TEXT NOT NULL, attempted_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id, type, record_id))`,
  `CREATE TABLE IF NOT EXISTS embedding_receipts (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), model_key TEXT NOT NULL, id TEXT NOT NULL,
    type TEXT NOT NULL, record_id TEXT NOT NULL, revision TEXT NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    neighbor_mean REAL, neighbor_std REAL,
    PRIMARY KEY(project_id, model_key, id))`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_receipts_source ON embedding_receipts(project_id, model_key, type, record_id, revision, ready)`,
  `CREATE TABLE IF NOT EXISTS embedding_cursors (
    project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}), next_type INTEGER NOT NULL DEFAULT 0,
    hubness_model TEXT, hubness_count INTEGER, hubness_target_count INTEGER, hubness_cursor TEXT)`,
  `CREATE TABLE IF NOT EXISTS embedding_hubness_work (
    project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}), target TEXT NOT NULL, after_id TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0, mean REAL NOT NULL DEFAULT 0, m2 REAL NOT NULL DEFAULT 0)`,
  ...EMBEDDING_SOURCES.flatMap((s) => [
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_ai AFTER INSERT ON ${s.table} BEGIN
      ${newSourceRevision(s)} END`,
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_au AFTER UPDATE OF ${s.columns} ON ${s.table} BEGIN
      ${newSourceRevision(s)} END`,
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_ad AFTER DELETE ON ${s.table} BEGIN
      DELETE FROM embedding_versions WHERE project_id = old.project_id AND type = '${s.type}' AND record_id = old.${s.id}; END`,
    `INSERT OR IGNORE INTO embedding_versions(project_id, type, record_id, revision) SELECT project_id, '${s.type}', ${s.id}, lower(hex(randomblob(16))) FROM ${s.table}`,
  ]),
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map((op) => {
    const rows: Array<'old' | 'new'> = op === 'UPDATE' ? ['old', 'new'] : [op === 'DELETE' ? 'old' : 'new'];
    return `CREATE TRIGGER IF NOT EXISTS knowledge_release_embedding_${op.toLowerCase()} AFTER ${op} ON knowledge_release_state BEGIN
      ${rows.map((row) => newReleaseRecordRevision(row)).join('\n')} END`;
  }),
  embeddingSourcesView(EMBEDDING_SOURCES),
];
