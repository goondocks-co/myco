import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_TELEMETRY_EXACT } from './schema-vNEXT-telemetry-exact.js';

const triggers = [
  'telemetry_session_arrived', 'telemetry_session_changed', 'telemetry_turn_arrived',
  'telemetry_document_arrived', 'telemetry_document_created', 'telemetry_remote_bound',
  'telemetry_session_deleted', 'telemetry_session_tombstoned',
];
const indexes = ['idx_sessions_telemetry_start', 'idx_session_prompts_telemetry_time', 'idx_telemetry_resolutions_invoker', 'idx_telemetry_dependency_window'];
const signal = (side: 'NEW' | 'OLD') => `UPDATE telemetry_totals SET source_revision=source_revision+1,work_due=0 WHERE id=1;
 INSERT INTO telemetry_session_changes(project_id,session_id,revision) VALUES(${side}.project_id,${side}.session_id,1)
 ON CONFLICT(project_id,session_id) DO UPDATE SET revision=revision+1,cursor_trace='',cursor_key='';`;

/** Exact identities wake when capture changes their availability. */
export const TELEMETRY_EXACT_STEPS: readonly SchemaStep[] = [{
  version: NEXT_TELEMETRY_EXACT,
  statements: [
    ...triggers.map(name => `DROP TRIGGER IF EXISTS ${name}`),
    ...indexes.map(name => `DROP INDEX IF EXISTS ${name}`),
    'DROP TABLE IF EXISTS telemetry_dependency_windows',
    "DELETE FROM telemetry_resolutions WHERE matched_by='inferred'",
    "DELETE FROM telemetry_session_changes WHERE scope='project'",
    ...([
      ['telemetry_session_arrived', 'INSERT', 'sessions', 'NEW'],
      ['telemetry_session_deleted', 'DELETE', 'sessions', 'OLD'],
      ['telemetry_session_tombstoned', 'INSERT', 'session_tombstones', 'NEW'],
    ] as const).map(([name, event, table, side]) => `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}
 WHEN EXISTS(SELECT 1 FROM telemetry_dependency_ids WHERE session_id=${side}.session_id) BEGIN ${signal(side)} END`),
  ],
  retires: [
    ...retiring('trigger', triggers, 'Session availability alone wakes exact identity dependencies.'),
    ...retiring('index', indexes, 'Exact resolution has no repository or time candidates.'),
    ...retiring('table', ['telemetry_dependency_windows'], 'Exact resolution watches named session identities.'),
  ],
  reaches: [
    ...changing(['telemetry_resolutions', 'telemetry_session_changes'], 'Remove time dependencies and inferred facts while preserving exact assertions.'),
    ...reaching(['sessions', 'session_tombstones'], 'Retire time notifications and retain exact session availability notifications.'),
  ],
}];
