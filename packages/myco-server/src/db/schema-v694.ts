const changed = (project: string): string => `INSERT INTO spore_curation_changes(project_id,revision,dirty) VALUES(${project},1,1)
  ON CONFLICT(project_id) DO UPDATE SET revision=revision+1,dirty=1;`;

/** Cluster assignments retain prior pair decisions as immutable history. */
export const V694_STATEMENTS: readonly string[] = [
  'ALTER TABLE spore_curation_work RENAME TO spore_curation_pair_history',
  'DROP INDEX idx_curation_due',
  'DROP INDEX idx_curation_evidence',
  `CREATE TABLE IF NOT EXISTS spore_curation_work (
    project_id TEXT NOT NULL REFERENCES projects(project_id), cluster_key TEXT NOT NULL, members TEXT NOT NULL CHECK(json_valid(members)),
    due_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, run_id TEXT, close_token TEXT,
    decision TEXT CHECK(decision IN ('keep','resolved','changed','failed','oversized')), reason TEXT, decided_at INTEGER,
    PRIMARY KEY(project_id,cluster_key),
    CHECK(decision IS NULL OR (reason IS NOT NULL AND length(trim(reason))>0 AND decided_at IS NOT NULL)))`,
  'CREATE INDEX IF NOT EXISTS idx_curation_due ON spore_curation_work(project_id,due_at,cluster_key) WHERE due_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_curation_evidence ON spore_curation_work(project_id,run_id,decision)',
  `CREATE TABLE IF NOT EXISTS spore_curation_owners (project_id TEXT NOT NULL, spore_id TEXT NOT NULL, cluster_key TEXT NOT NULL,
    PRIMARY KEY(project_id,spore_id), FOREIGN KEY(project_id,cluster_key) REFERENCES spore_curation_work(project_id,cluster_key))`,
  'CREATE INDEX IF NOT EXISTS idx_curation_owners_cluster ON spore_curation_owners(project_id,cluster_key)',
  `CREATE TABLE IF NOT EXISTS spore_curation_receipts (project_id TEXT NOT NULL, spore_id TEXT NOT NULL, revision INTEGER NOT NULL, cluster_key TEXT NOT NULL,
    PRIMARY KEY(project_id,spore_id), FOREIGN KEY(project_id,cluster_key) REFERENCES spore_curation_work(project_id,cluster_key))`,
  'CREATE INDEX IF NOT EXISTS idx_curation_receipts_cluster ON spore_curation_receipts(project_id,cluster_key)',
  `CREATE TABLE IF NOT EXISTS spore_curation_candidates (project_id TEXT NOT NULL REFERENCES projects(project_id), run_id TEXT NOT NULL,
    spore_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(project_id,run_id,spore_id),
    FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id) ON DELETE CASCADE)`,
  'ALTER TABLE spore_curation_cursor ADD COLUMN pass_revision INTEGER NOT NULL DEFAULT -1',
  'ALTER TABLE spore_curation_cursor ADD COLUMN active INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS spore_curation_changes (project_id TEXT PRIMARY KEY REFERENCES projects(project_id), revision INTEGER NOT NULL, dirty INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_curation_changes_due ON spore_curation_changes(dirty,project_id)',
  `INSERT INTO spore_curation_changes SELECT project_id,1,1 FROM project_capabilities WHERE capability='spore_curation' AND enabled=1`,
  ...(['INSERT','UPDATE','DELETE'] as const).map(op => `CREATE TRIGGER IF NOT EXISTS curation_capability_${op.toLowerCase()} AFTER ${op} ON project_capabilities
    WHEN ${op === 'DELETE' ? 'OLD' : 'NEW'}.capability IN ('spore_curation','spore_curation_backfill') BEGIN ${changed(`${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id`)} END`),
  ...(['INSERT','UPDATE','DELETE'] as const).map(op => `CREATE TRIGGER IF NOT EXISTS curation_spore_${op.toLowerCase()} AFTER ${op === 'UPDATE' ? 'UPDATE OF revision,created_at,updated_at' : op} ON spores
    BEGIN ${changed(`${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id`)} END`),
  ...(['INSERT','UPDATE','DELETE'] as const).map(op => `CREATE TRIGGER IF NOT EXISTS curation_vector_${op.toLowerCase()} AFTER ${op === 'UPDATE' ? 'UPDATE OF project_id,model_key,id,record_id,revision,ready,updated_at' : op} ON embedding_receipts
    WHEN ${op === 'DELETE' ? 'OLD' : 'NEW'}.type='spore' BEGIN ${changed(`${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id`)} END`),
  `CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT NOT NULL REFERENCES projects(project_id), leaf TEXT NOT NULL, value TEXT NOT NULL,
    updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(project_id,leaf))`,
];
