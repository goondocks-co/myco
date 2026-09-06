import { PROJECT_ID_GRAMMAR } from './project-id.js';

const sources = [
  { table: 'sessions', type: 'session', id: 'session_id', columns: 'title, summary, started_at, ended_at',
    title: "COALESCE(title, 'Session')", text: "COALESCE(title, '') || char(10) || summary", blob: 'NULL',
    status: "CASE WHEN ended_at IS NULL THEN 'active' ELSE 'completed' END", session: 'session_id', prompt: 'NULL', created: 'COALESCE(started_at, first_received_at)', observation: "''", eligible: "summary IS NOT NULL AND trim(summary) <> ''" },
  { table: 'spores', type: 'spore', id: 'id', columns: 'content, context, status, session_id, prompt_id, observation_type, created_at',
    title: 'observation_type', text: "content || char(10) || COALESCE(context, '')", blob: 'NULL', status: 'status', session: 'session_id', prompt: 'prompt_id', created: 'created_at', observation: 'observation_type', eligible: "status = 'active'" },
  { table: 'plans', type: 'plan', id: 'plan_key', columns: 'title, content, blob_key, content_hash, status, session_id, prompt_id, created_at',
    title: "COALESCE(title, 'Plan')", text: "COALESCE(title, '') || char(10) || COALESCE(content, '')", blob: 'blob_key', status: 'status', session: 'session_id', prompt: 'prompt_id', created: 'created_at', observation: "''", eligible: 'content IS NOT NULL OR blob_key IS NOT NULL' },
  { table: 'skill_records', type: 'skill', id: 'id', columns: 'name, display_name, description, status, generation, created_at',
    title: "COALESCE(NULLIF(display_name, ''), name)", text: "name || char(10) || description", blob: 'NULL', status: 'status', session: 'NULL', prompt: 'NULL', created: 'created_at', observation: "''", eligible: "status = 'active'" },
] as const;

const sourceUnion = sources.map((s) => `SELECT project_id, '${s.type}' AS type, '${s.table}' AS namespace, ${s.id} AS record_id,
  ${s.title} AS title, ${s.text} AS text, ${s.blob} AS blob_key, ${s.status} AS status,
  COALESCE(${s.session}, '') AS session_id, ${s.prompt} AS prompt_id, ${s.created} AS created_at, ${s.observation} AS observation_type
  FROM ${s.table} WHERE ${s.eligible}`).join(' UNION ALL ');

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
  ...sources.flatMap((s) => [
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_ai AFTER INSERT ON ${s.table} BEGIN
      INSERT INTO embedding_versions(project_id, type, record_id, revision) VALUES(new.project_id, '${s.type}', new.${s.id}, lower(hex(randomblob(16))))
      ON CONFLICT(project_id, type, record_id) DO UPDATE SET revision = excluded.revision; END`,
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_au AFTER UPDATE OF ${s.columns} ON ${s.table} BEGIN
      INSERT INTO embedding_versions(project_id, type, record_id, revision) VALUES(new.project_id, '${s.type}', new.${s.id}, lower(hex(randomblob(16))))
      ON CONFLICT(project_id, type, record_id) DO UPDATE SET revision = excluded.revision; END`,
    `CREATE TRIGGER IF NOT EXISTS ${s.table}_embedding_ad AFTER DELETE ON ${s.table} BEGIN
      DELETE FROM embedding_versions WHERE project_id = old.project_id AND type = '${s.type}' AND record_id = old.${s.id}; END`,
    `INSERT OR IGNORE INTO embedding_versions(project_id, type, record_id, revision) SELECT project_id, '${s.type}', ${s.id}, lower(hex(randomblob(16))) FROM ${s.table}`,
  ]),
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map((op) => {
    const rows = op === 'UPDATE' ? ['old', 'new'] : [op === 'DELETE' ? 'old' : 'new'];
    return `CREATE TRIGGER IF NOT EXISTS knowledge_release_embedding_${op.toLowerCase()} AFTER ${op} ON knowledge_release_state BEGIN
      ${rows.map((row) => `UPDATE embedding_versions SET revision = lower(hex(randomblob(16))) WHERE project_id = ${row}.project_id AND record_id = ${row}.record_id
      AND type = CASE ${row}.namespace ${sources.map((s) => `WHEN '${s.table}' THEN '${s.type}'`).join(' ')} END;`).join('\n')} END`;
  }),
  `CREATE VIEW IF NOT EXISTS embedding_sources AS SELECT s.*, v.revision,
    COALESCE((SELECT k.state FROM knowledge_release_state k WHERE k.project_id = s.project_id AND k.namespace = s.namespace AND k.record_id = s.record_id ORDER BY k.checked_at DESC, k.id LIMIT 1), '') AS release_state,
    COALESCE((SELECT k.confidence FROM knowledge_release_state k WHERE k.project_id = s.project_id AND k.namespace = s.namespace AND k.record_id = s.record_id ORDER BY k.checked_at DESC, k.id LIMIT 1), '') AS release_confidence
    FROM (${sourceUnion}) s JOIN embedding_versions v ON v.project_id = s.project_id AND v.type = s.type AND v.record_id = s.record_id`,
];
