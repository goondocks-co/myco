import { CURRENT_EMBEDDING_SOURCES } from './embedding-sources.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

const sessionEligibility = CURRENT_EMBEDDING_SOURCES.find((source) => source.type === 'session')!.eligible;

const dirty = (table: string, kinds = "'embedding','hubness'", update = 'UPDATE', when?: (operation: string) => string): string[] =>
  ['INSERT', update, 'DELETE'].map((operation) => {
    const rows = operation.startsWith('UPDATE') ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
    return `CREATE TRIGGER IF NOT EXISTS ${table}_work_${operation.split(' ')[0]!.toLowerCase()} AFTER ${operation} ON ${table} ${when === undefined ? '' : `WHEN ${when(operation)}`} BEGIN
      UPDATE embedding_work_state SET revision=revision+1,pending=1,wake_at=NULL,sweep_cursor=NULL,idle_rounds=0
        WHERE project_id IN (${rows.map((row) => `${row}.project_id`).join(',')}) AND kind IN (${kinds}); END`;
  });

/** Derivable embedding wake markers and indexes for source, receipt and retry selection. */
export const V82_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS embedding_work_state (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), model_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('embedding','hubness')), scope TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, checked_revision INTEGER NOT NULL DEFAULT -1,
    pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)), wake_at INTEGER,
    sweep_at INTEGER NOT NULL DEFAULT 0, sweep_cursor TEXT, idle_rounds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id,model_key,kind))`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_versions_attempt ON embedding_versions(project_id,type,attempted_at,record_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_receipts_identity ON embedding_receipts(project_id,type,record_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_receipts_retire ON embedding_receipts(project_id,model_key,updated_at,id) WHERE ready >= 0`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_receipts_delete ON embedding_receipts(project_id,ready,updated_at,id) WHERE ready < 0`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_receipts_spore ON embedding_receipts(project_id,model_key,id) WHERE type = 'spore' AND ready = 1`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_failures_retry ON embedding_source_failures(project_id,model_key,recorded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_release_embedding ON knowledge_release_state(project_id,namespace,record_id,checked_at DESC,id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_task_live ON agent_runs(task,status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_entry ON agent_runs(project_id,task,COALESCE(queued_at,started_at) DESC) WHERE status != 'skipped'`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_skipped_entry ON agent_runs(project_id,task,run_context,COALESCE(queued_at,started_at) DESC) WHERE status = 'skipped'`,
  ...dirty('embedding_versions', undefined, 'UPDATE OF project_id,type,record_id,revision', (operation) => {
    const rows = operation === 'INSERT' ? ['NEW'] : operation === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    return rows.map((row) => `(${row}.type <> 'session' OR EXISTS (SELECT 1 FROM sessions
      WHERE project_id=${row}.project_id AND session_id=${row}.record_id AND ${sessionEligibility})
      OR EXISTS (SELECT 1 FROM embedding_receipts WHERE project_id=${row}.project_id AND type='session' AND record_id=${row}.record_id))`).join(' OR ');
  }),
  ...dirty('embedding_receipts', undefined, 'UPDATE OF project_id,model_key,id,type,record_id,revision,ready,updated_at,rewrites'),
  ...dirty('embedding_source_failures'),
  ...dirty('processed_resources', undefined, undefined, (operation) => operation === 'INSERT' ? "NEW.kind = 'plan'" : operation === 'DELETE' ? "OLD.kind = 'plan'" : "OLD.kind = 'plan' OR NEW.kind = 'plan'"),
  ...dirty('embedding_hubness_members', "'hubness'"),
  ...dirty('embedding_cursors', "'hubness'", 'UPDATE OF hubness_model,hubness_count,hubness_cursor'),
];
