import { Database } from 'bun:sqlite';

/** The source database shape captured before object generations and archived-content storage existed. */
export function asSchema41(file: string): void {
  const db = new Database(file);
  try {
    for (const trigger of [
      'events_content_revision', 'tool_calls_content_revision', 'events_cleanup_queue',
      'tool_calls_cleanup_queue', 'events_raw_archive_queue', 'transcript_segments_raw_archive_queue',
      'transcripts_raw_archive_first', 'blobs_require_generation', 'blobs_release_through_journal',
    ]) db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    for (const table of [
      'registered_content_proofs', 'event_content_refs', 'content_scan_checkpoints', 'raw_archive_refs',
      'storage_cleanup_state', 'storage_cleanup_queue', 'storage_cleanup_omissions', 'raw_archive_state',
      'orphan_sweep_state', 'storage_content_guard',
      'object_releases', 'blob_release_candidates', 'backup_release_candidates', 'recovery_holds', 'restore_reference_guard',
    ]) db.run(`DROP TABLE IF EXISTS ${table}`);
    for (const [table, columns] of [
      ['events', ['payload_format', 'content_revision']],
      ['tool_calls', ['input_bytes', 'content_revision']],
      ['blob_reservations', ['authority_kind', 'source_kind', 'source_id', 'source_event_id', 'source_envelope_hash', 'source_session_id']],
    ] as const) for (const column of columns) db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    db.run('DROP INDEX idx_blob_reservations_expiry');
    db.run('ALTER TABLE blobs DROP COLUMN generation');
    db.run("UPDATE schema_meta SET value = '41' WHERE key = 'version'");
  } finally { db.close(); }
}
