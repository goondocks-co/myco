import { queueRetirementSql as queue } from './embedding-retirement.js';
import { SCHEDULE_ACTOR_SQL, SCHEDULE_ENTRY_SQL } from './schedule-entry.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

const identity = (row: string) => `project_id=${row}.project_id AND type=${row}.type AND record_id=${row}.record_id`;

/** Each populated index is its own schema transaction. Retirement queues start empty and safety scans seek by identity. */
export const READ_COST_STEPS = [
  ['CREATE INDEX IF NOT EXISTS idx_plans_project_updated ON plans(project_id,updated_at DESC,plan_key DESC)'],
  ['CREATE INDEX IF NOT EXISTS idx_plans_project_status_updated ON plans(project_id,status,updated_at DESC,plan_key DESC)'],
  [
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_schedule_entry ON agent_runs(project_id,task,${SCHEDULE_ACTOR_SQL},COALESCE(queued_at,started_at) DESC) WHERE ${SCHEDULE_ENTRY_SQL}`,
  ],
  [
    "CREATE INDEX IF NOT EXISTS idx_raw_archive_transcript_page ON raw_archive_refs(project_id,transcript_id,base_offset,archive_key) WHERE source_kind='transcript' AND disposition='archived'",
  ],
  [
    `CREATE TABLE IF NOT EXISTS embedding_retirement_queue(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
      model_key TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(project_id,model_key,id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS embedding_retirement_scan(project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}),
      scope TEXT NOT NULL,model_key TEXT NOT NULL DEFAULT '',id TEXT NOT NULL DEFAULT '',due_at INTEGER NOT NULL DEFAULT 0)`,
    ...['embedding_versions', 'embedding_receipts'].flatMap((table) =>
      ['INSERT', 'UPDATE', 'DELETE'].map(
        (op) =>
          `CREATE TRIGGER IF NOT EXISTS ${table}_retirement_${op.toLowerCase()} AFTER ${
            op === 'UPDATE'
              ? table === 'embedding_versions'
                ? 'UPDATE OF project_id,type,record_id,revision'
                : 'UPDATE OF project_id,model_key,id,type,record_id,revision,ready'
              : op
          } ON ${table} BEGIN
        ${(op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW']).map((row) => queue(identity(row))).join(' ')}
        ${
          table === 'embedding_receipts' && op !== 'INSERT'
            ? `DELETE FROM embedding_retirement_queue
          WHERE project_id=OLD.project_id AND model_key=OLD.model_key AND id=OLD.id
            AND NOT EXISTS(SELECT 1 FROM embedding_receipts WHERE project_id=OLD.project_id AND model_key=OLD.model_key AND id=OLD.id);`
            : ''
        } END`,
      ),
    ),
    ...['INSERT', 'UPDATE', 'DELETE'].map(
      (op) => `CREATE TRIGGER IF NOT EXISTS processed_resources_retirement_${op.toLowerCase()} AFTER ${op} ON processed_resources BEGIN
      ${(op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW']).map((row) => queue(`project_id=${row}.project_id AND type='plan' AND record_id=${row}.resource_id AND ${row}.kind='plan'`)).join(' ')} END`,
    ),
  ],
].map((statements, index) => ({ version: 538 + index, statements }));
