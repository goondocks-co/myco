import { captureHeadTriggers } from './runners/capture-heads.js';
import { changing, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_ATTENTION } from './schema-vNEXT-attention.js';

const triggers = captureHeadTriggers();
/**
 * Pending trust seeds only existing heads through the live-start window. Session proof starts empty.
 * Live activity uses each pair's indexed live-receipt maximum.
 * Observed trust survives receipt replacement; removing a pair's final session removes its head and proof.
 * The deployed Worker requires idx_sessions_machine_live; a later step drops it once no deployed Worker names it.
 * Member capture and claims require an exact schema version; the deployed Worker refuses them during handoff.
 */
export const ATTENTION_STEPS: readonly SchemaStep[] = [{
  version: NEXT_ATTENTION,
  statements: [
    'ALTER TABLE sessions ADD COLUMN last_trust_start_at INTEGER',
    'ALTER TABLE machine_capture_heads ADD COLUMN last_live_received_at INTEGER',
    'ALTER TABLE machine_capture_heads ADD COLUMN last_trust_start_at INTEGER',
    `WITH pending AS MATERIALIZED (
      SELECT r.machine_id,json_quote(r.harness) AS agent_json,r.since_at FROM machine_harness_reports r
      JOIN machine_claims mc ON mc.machine_id=r.machine_id JOIN members m ON m.id=mc.member_id
      WHERE r.state='trust_required' AND m.revoked_at IS NULL
    ), oldest AS MATERIALIZED (SELECT MIN(since_at) AS at FROM pending), starts AS MATERIALIZED (
      SELECT s.machine_id,json_quote(s.agent) AS agent_json,MAX(MIN(e.created_at,e.received_at)) AS at FROM oldest o
      CROSS JOIN sessions s INDEXED BY idx_sessions_capture CROSS JOIN events e INDEXED BY idx_events_session
      WHERE s.machine_id IS NOT NULL AND s.agent IS NOT NULL AND s.last_received_at>o.at
        AND (s.machine_id,json_quote(s.agent)) IN (SELECT machine_id,agent_json FROM pending)
        AND e.project_id=s.project_id AND e.session_id=s.session_id
        AND e.received_at>o.at AND e.created_at>o.at AND e.kind='session.start' AND e.channel<>'import'
      GROUP BY s.machine_id,s.agent
    ) UPDATE machine_capture_heads AS h SET last_trust_start_at=starts.at
      FROM starts JOIN pending p ON p.machine_id=starts.machine_id AND p.agent_json=starts.agent_json
      WHERE h.machine_id=starts.machine_id AND h.agent_json=starts.agent_json AND starts.at>p.since_at`,
    `UPDATE machine_capture_heads AS h SET last_live_received_at=(SELECT s.last_live_received_at
      FROM sessions s INDEXED BY idx_sessions_harness_live WHERE s.machine_id=h.machine_id
        AND s.agent IS json_extract(h.agent_json,'$') AND s.last_live_received_at IS NOT NULL
      ORDER BY s.last_live_received_at DESC LIMIT 1)`,
    'CREATE INDEX IF NOT EXISTS idx_sessions_unclaimed_live ON sessions(last_live_received_at) WHERE machine_id IS NULL AND last_live_received_at IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_sessions_harness_trust_start ON sessions(machine_id,agent,last_trust_start_at DESC) WHERE last_trust_start_at IS NOT NULL',
    ...triggers.map(item => `DROP TRIGGER IF EXISTS ${item.name}`),
    ...triggers.map(item => item.sql),
  ],
  reaches: [
    ...changing(['sessions', 'machine_capture_heads'], 'Session receipts and starts retain live evidence on the existing capture heads.'),
  ],
  retires: [
    ...retiring('trigger', triggers.map(item => item.name), 'Session heads carry live evidence independently of receipt identity.'),
  ],
  deploymentIndexes: [
    { index: 'idx_sessions_harness_trust_start', read: 'A removed live-start head seeks its replacement within one machine and harness.' },
    { index: 'idx_sessions_unclaimed_live', read: 'The live capture mark seeks only the latest legacy receipt outside machine heads.' },
  ],
}];
