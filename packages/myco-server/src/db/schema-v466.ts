import { reaching, type Reach, changing } from './schema-step.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { refreshEmbeddingDue } from './embedding-due.js';

const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;

/** Model-specific due identities and bounded initialization frontiers. All indexes start on empty tables. */
export const V466_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS embedding_hubness_revision (${project},revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id))`,
  `CREATE TABLE IF NOT EXISTS embedding_hubness_population (${project},model_key TEXT NOT NULL,revision INTEGER NOT NULL,total INTEGER NOT NULL,
    covered INTEGER NOT NULL,members INTEGER NOT NULL,miscounted INTEGER NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(project_id))`,
  `CREATE TABLE IF NOT EXISTS embedding_hubness_commits (${project},token TEXT NOT NULL,PRIMARY KEY(project_id))`,
  ...['embedding_versions','embedding_receipts'].flatMap(table => ['INSERT','UPDATE','DELETE'].map(op =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_hubness_source_${op.toLowerCase()} AFTER ${table === 'embedding_receipts' && op === 'UPDATE' ? 'UPDATE OF project_id,model_key,id,type,record_id,revision,ready,rewrites' : table === 'embedding_versions' && op === 'UPDATE' ? 'UPDATE OF project_id,type,record_id,revision' : op} ON ${table}
      BEGIN ${(op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD','NEW']).map(row =>
        `INSERT INTO embedding_hubness_revision(project_id,revision) SELECT ${row}.project_id,1 WHERE ${row}.type='spore'
          ON CONFLICT(project_id) DO UPDATE SET revision=revision+1;
         DELETE FROM embedding_hubness_population WHERE project_id=${row}.project_id AND ${row}.type='spore';`).join(' ')} END`)),
  ...['INSERT','UPDATE','DELETE'].map(op => `CREATE TRIGGER IF NOT EXISTS embedding_hubness_members_population_${op.toLowerCase()} AFTER ${op} ON embedding_hubness_members
    BEGIN DELETE FROM embedding_hubness_population WHERE project_id=${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id
      AND NOT EXISTS(SELECT 1 FROM embedding_hubness_members WHERE project_id=${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id AND model_key=${op === 'DELETE' ? 'OLD' : 'NEW'}.model_key AND state IN (1,2)); END`),
  `CREATE TABLE IF NOT EXISTS embedding_provider_holds(model_key TEXT PRIMARY KEY,failures INTEGER NOT NULL,retry_at INTEGER,reason TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO schema_meta(key,value) VALUES('embedding_provider_revision','0')`,
  ...['deployment_settings','deployment_secrets'].flatMap(table => ['INSERT','UPDATE','DELETE'].map(op =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_embedding_provider_${op.toLowerCase()} AFTER ${op} ON ${table}${table === 'deployment_settings' ? `
      WHEN ${(op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD','NEW']).map(row => `${row}.leaf IN ('embedding.provider','embedding.model','embedding.base_url')`).join(' OR ')}` : ''}
      BEGIN DELETE FROM embedding_provider_holds;
        UPDATE schema_meta SET value=CAST(value AS INTEGER)+1 WHERE key='embedding_provider_revision'; END`)),
  `CREATE TABLE IF NOT EXISTS embedding_models (${project},model_key TEXT NOT NULL,scan_type TEXT NOT NULL DEFAULT '',scan_id TEXT NOT NULL DEFAULT '',
    complete INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(project_id,model_key))`,
  `CREATE TABLE IF NOT EXISTS embedding_due (${project},model_key TEXT NOT NULL,type TEXT NOT NULL,record_id TEXT NOT NULL,revision TEXT NOT NULL,
    stale INTEGER NOT NULL,retry_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL,PRIMARY KEY(project_id,model_key,type,record_id))`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_due_next ON embedding_due(project_id,model_key,type,stale,retry_at,attempted_at,record_id)`,
  ...['embedding_versions','embedding_receipts','embedding_source_failures'].flatMap(table => ['INSERT','UPDATE','DELETE'].map(op =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_due_${op.toLowerCase()} AFTER ${op === 'UPDATE' && table === 'embedding_versions' ? 'UPDATE OF project_id,type,record_id,revision,attempted_at' : op === 'UPDATE' && table === 'embedding_receipts' ? 'UPDATE OF project_id,model_key,id,type,record_id,revision,ready' : op} ON ${table}
      BEGIN ${op === 'INSERT' ? '' : refreshEmbeddingDue('OLD')} ${op === 'DELETE' ? '' : refreshEmbeddingDue('NEW')} END`)),
  ...['INSERT','UPDATE','DELETE'].map(op => `CREATE TRIGGER IF NOT EXISTS processed_resources_due_${op.toLowerCase()} AFTER ${op} ON processed_resources WHEN ${(op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD','NEW']).map(row=>`${row}.kind='plan'`).join(' OR ')} BEGIN
    ${ (op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD','NEW']).map(row =>
      refreshEmbeddingDue(row, "'plan'", `${row}.resource_id`)).join(' ')} END`),
];

/** Why the step reaches tables earlier steps created. */
export const V466_REACHES: readonly Reach[] = [
  ...reaching(['embedding_versions', 'embedding_receipts', 'embedding_hubness_members', 'deployment_settings', 'deployment_secrets', 'embedding_source_failures', 'processed_resources'], 'Catalog mutations maintain embedding and publication facts atomically.'),
  ...changing(['schema_meta'], 'Provider configuration changes fence pending provider failures.'),
];
