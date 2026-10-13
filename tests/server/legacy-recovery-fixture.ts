import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '../../packages/myco-server/src/db/schema.js';

/** The source database shape captured before object generations and archived-content storage existed. */
export function asSchema41(file: string): void {
  const db = new Database(file);
  try {
    const historical = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS.filter(({ version }) => version <= 41)) {
        for (const statement of step.statements) historical.run(statement);
      }
      const retired = ['skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage', 'digest_extracts', 'digest_extract_revisions', 'skill_records_fts'];
      const objects = historical.query<{ name: string; sql: string }, [string]>(`SELECT name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND (name IN (SELECT value FROM json_each(?1)) OR tbl_name IN (SELECT value FROM json_each(?1)))
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`).all(JSON.stringify(retired));
      for (const object of objects) {
        if (db.query('SELECT 1 FROM sqlite_master WHERE name = ?').get(object.name) === null) db.run(object.sql);
      }
    } finally { historical.close(); }
    for (const trigger of [
      'events_content_revision', 'tool_calls_content_revision', 'events_cleanup_queue',
      'tool_calls_cleanup_queue', 'tool_calls_bundle_cleanup_queue', 'events_raw_archive_queue', 'transcript_segments_raw_archive_queue',
      'transcripts_raw_archive_first', 'blobs_require_generation', 'blobs_release_through_journal',
    ]) db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    for (const table of [
      'registered_content_proofs', 'archive_bundles', 'raw_event_archive_state', 'content_scan_checkpoints', 'raw_archive_refs',
      'storage_cleanup_state', 'storage_cleanup_queue', 'storage_cleanup_omissions', 'raw_archive_state',
      'orphan_sweep_state', 'storage_content_guard',
      'object_releases', 'blob_release_candidates', 'backup_release_candidates', 'recovery_holds', 'restore_reference_guard',
    ]) db.run(`DROP TABLE IF EXISTS ${table}`);
    for (const [table, columns] of [
      ['events', ['payload_format', 'content_revision', 'bundle_id', 'bundle_entry', 'archived_ended_at', 'archived_title_only_end', 'archived_prompt_origin']],
      ['tool_calls', ['input_bytes', 'content_revision', 'input_bundle_id', 'input_bundle_entry']],
      ['blob_reservations', ['authority_kind', 'source_kind', 'source_id', 'source_event_id', 'source_envelope_hash', 'source_session_id']],
    ] as const) for (const column of columns) db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    db.run('DROP INDEX idx_blob_reservations_expiry');
    db.run('ALTER TABLE blobs DROP COLUMN generation');
    db.run("UPDATE schema_meta SET value = '41' WHERE key = 'version'");
  } finally { db.close(); }
}
