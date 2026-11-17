import { captureHeadTriggers } from './runners/capture-heads.js';
import { changing, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_ATTENTION } from './schema-vNEXT-attention.js';

const triggers = captureHeadTriggers();
/** Live starts cross both client and receipt clocks before they can confirm a trust epoch. */
export const ATTENTION_STEPS: readonly SchemaStep[] = [{
  version: NEXT_ATTENTION,
  statements: [
    'ALTER TABLE sessions ADD COLUMN last_trust_start_at INTEGER',
    'DROP INDEX idx_sessions_machine_live',
    'CREATE INDEX IF NOT EXISTS idx_sessions_unclaimed_live ON sessions(last_live_received_at) WHERE machine_id IS NULL AND last_live_received_at IS NOT NULL',
    'ALTER TABLE machine_capture_heads ADD COLUMN last_live_received_at INTEGER',
    'ALTER TABLE machine_capture_heads ADD COLUMN last_trust_start_at INTEGER',
    `UPDATE sessions SET last_trust_start_at=(SELECT MAX(MIN(e.created_at,e.received_at)) FROM events e
      WHERE e.project_id=sessions.project_id AND e.session_id=sessions.session_id AND e.kind='session.start' AND e.channel<>'import')`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_harness_trust_start ON sessions(machine_id,agent,last_trust_start_at DESC) WHERE last_trust_start_at IS NOT NULL`,
    `UPDATE machine_capture_heads SET
      last_live_received_at=(SELECT s.last_live_received_at FROM sessions s WHERE s.machine_id=machine_capture_heads.machine_id
        AND s.agent IS json_extract(machine_capture_heads.agent_json,'$') AND s.last_live_received_at IS NOT NULL ORDER BY s.last_live_received_at DESC LIMIT 1),
      last_trust_start_at=(SELECT s.last_trust_start_at FROM sessions s WHERE s.machine_id=machine_capture_heads.machine_id
        AND s.agent IS json_extract(machine_capture_heads.agent_json,'$') AND s.last_trust_start_at IS NOT NULL ORDER BY s.last_trust_start_at DESC LIMIT 1)`,
    ...triggers.map(item => `DROP TRIGGER ${item.name}`),
    ...triggers.map(item => item.sql),
  ],
  reaches: [
    ...changing(['sessions', 'machine_capture_heads'], 'Session receipts and starts retain live evidence on the existing capture heads.'),
  ],
  retires: [
    ...retiring('trigger', triggers.map(item => item.name), 'Session heads carry live evidence independently of receipt identity.'),
    ...retiring('index', ['idx_sessions_machine_live'], 'Machine capture heads serve live activity; only unclaimed legacy sessions need the receipt index.'),
  ],
  deploymentIndexes: [
    { index: 'idx_sessions_harness_trust_start', read: 'A removed live-start head seeks its replacement within one machine and harness.' },
    { index: 'idx_sessions_unclaimed_live', read: 'The live capture mark seeks only the latest legacy receipt outside machine heads.' },
  ],
}];
