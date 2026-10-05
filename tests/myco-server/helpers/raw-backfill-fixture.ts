const lit = (value: string): string => "'" + value.replaceAll("'", "''") + "'";

export const HISTORICAL_BLOBS = 1_105;
export const HISTORICAL_PLANS = 205;
export const HISTORICAL_EVENTS = 10_000;
export const HISTORICAL_TRANSCRIPTS = 1_005;
export const BACKFILL_PROJECTS = ['proj_backfill_a', 'proj_backfill_b'] as const;

/** Source rows written without a provenance schema, including retained and mixed transcript segments. */
export function historicalBackfillSql(now: number, member = 'member_backfill', machine = 'machine_backfill', credential = 'credential_backfill', events = HISTORICAL_EVENTS): string[] {
  const [a, b] = BACKFILL_PROJECTS;
  const seq = (count: number) => `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ${count})`;
  const project = `CASE WHEN i % 2 = 0 THEN ${lit(a)} ELSE ${lit(b)} END`;
  const key = `printf('%064x', CAST(i / 2 AS INTEGER))`;
  return [
    `INSERT INTO projects (project_id, name, created_at) VALUES (${lit(a)}, 'backfill a', ${now}), (${lit(b)}, 'backfill b', ${now})`,
    `INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (${lit(member)}, 'historical uploader', ${now}, 'member'), ('member_backfill_other', 'other uploader', ${now}, 'member')`,
    `INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(machine)}, ${lit(member)}, ${now}), ('machine_backfill_other', 'member_backfill_other', ${now})`,
    `INSERT OR IGNORE INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, lineage_root, lineage_started_at)
      VALUES (${lit(credential)}, ${lit(member)}, ${lit(machine)}, 'backfill historical digest', 0, 1, 1, 0, ${lit(credential)}, 0),
      ('credential_backfill_other', 'member_backfill_other', 'machine_backfill_other', 'other historical digest', 0, 1, 1, 0, 'credential_backfill_other', 0)`,
    `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES (${lit(a)}, 'backfill_session', ${lit(machine)}, ${lit(credential)}, ${now}, ${now}), (${lit(b)}, 'backfill_session', ${lit(machine)}, ${lit(credential)}, ${now}, ${now}),
      (${lit(a)}, 'backfill_bulk_session', ${lit(machine)}, ${lit(credential)}, ${now}, ${now}), (${lit(b)}, 'backfill_bulk_session', ${lit(machine)}, ${lit(credential)}, ${now}, ${now})`,
    `${seq(HISTORICAL_BLOBS)} INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
      SELECT ${project}, ${key}, 1, 'text/plain; charset=utf-8', ${lit(credential)}, ${now}, '00000000-0000-4000-8000-000000000001' FROM seq`,
    `INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
      SELECT project_id, 'held-' || key, 'backfill_session', 'held-' || key, key, media_type, size, ${now}, token_id, ${now} FROM blobs WHERE project_id IN (${lit(a)}, ${lit(b)})`,
    `${seq(events)} INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      SELECT ${project}, 'raw-event-' || printf('%05d', i), 'backfill_session', ${lit(credential)}, 'notification', 'cli', json_object('message', 'preserved ' || i), 'historical envelope hash', ${now}, ${now} FROM seq`,
    `${seq(HISTORICAL_PLANS)} INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      SELECT ${project}, 'plan-event-' || printf('%05d', i), 'backfill_session', ${lit(credential)}, 'plan', 'cli', json_object('planKey', 'plan-' || printf('%05d', i), 'blob', ${key}), 'historical plan hash', ${now}, ${now} FROM seq`,
    `${seq(HISTORICAL_PLANS)} INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      SELECT ${project}, 'plan-' || printf('%05d', i), 'backfill_session', 'plan-event-' || printf('%05d', i), ${lit(machine)}, 'historical spilled plan', NULL, ${key}, ${key}, 'active', ${now}, ${now}, ${lit(credential)}, ${now} FROM seq`,
    `INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, segment_count, first_received_at, last_received_at, token_id)
      VALUES (${lit(a)}, 'retained', 'backfill_session', ${lit(machine)}, 20, 20, ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'mixed', 'backfill_session', ${lit(machine)}, 20, 20, ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'unknown', 'backfill_session', 'missing_machine', 0, 0, ${now}, ${now}, 'missing_credential'),
      (${lit(a)}, 'conflicting', 'backfill_session', ${lit(machine)}, 0, 0, ${now}, ${now}, 'credential_backfill_other'),
      (${lit(b)}, 'known', 'backfill_session', ${lit(machine)}, 1, 1, ${now}, ${now}, ${lit(credential)})`,
    `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
      SELECT project_id, 'bulk-' || key, 'backfill_bulk_session', ${lit(machine)}, 20, 20, ${now}, ${now}, token_id FROM blobs WHERE key < printf('%064x', 500) AND project_id IN (${lit(a)}, ${lit(b)})`,
    `INSERT INTO transcript_segments (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
      SELECT project_id, transcript_id, 19, 1, substr(transcript_id, 6), 'bulk-segment-' || transcript_id, ${now}, ${now}, token_id FROM transcripts WHERE transcript_id LIKE 'bulk-%' AND project_id IN (${lit(a)}, ${lit(b)})`,
    `INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
      VALUES (${lit(a)}, 'retained', 19, 1, ${lit('0'.repeat(64))}, 'retained-segment', ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'mixed', 18, 1, ${lit('0'.repeat(64))}, 'mixed-own-segment', ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'mixed', 19, 1, ${lit('0'.repeat(64))}, 'mixed-other-segment', ${now}, ${now}, 'credential_backfill_other'),
      (${lit(b)}, 'known', 0, 1, ${lit('0'.repeat(64))}, 'known-segment', ${now}, ${now}, ${lit(credential)})`,
    `INSERT INTO prompt_batches (project_id,prompt_id,session_id,event_id,origin,blob_key,content_hash,created_at,updated_at,token_id,received_at)
      SELECT project_id, 'prompt-' || key, 'backfill_session', 'prompt-' || key, 'user', key, key, ${now}, ${now}, token_id, ${now} FROM blobs WHERE project_id IN (${lit(a)}, ${lit(b)})`,
    `INSERT INTO responses (project_id,response_id,session_id,event_id,blob_key,content_hash,created_at,token_id,received_at)
      SELECT project_id, 'response-' || key, 'backfill_session', 'response-' || key, key, key, ${now}, token_id, ${now} FROM blobs WHERE project_id IN (${lit(a)}, ${lit(b)})`,
    `INSERT INTO tool_calls (project_id,tool_call_id,session_id,event_id,tool_name,input_blob_key,output_blob_key,success,created_at,token_id,received_at)
      SELECT project_id, 'tool-' || key, 'backfill_session', 'tool-' || key, 'historical', key, key, 1, ${now}, token_id, ${now} FROM blobs WHERE project_id IN (${lit(a)}, ${lit(b)})`,
    `UPDATE transcripts SET parsed_offset = size WHERE project_id IN (${lit(a)}, ${lit(b)})`,
  ];
}
