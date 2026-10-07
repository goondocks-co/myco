import type { RelationalStore } from './adapters.js';

type Row = Record<string, unknown>;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Import an archived event only while its exact bundle and publication evidence are held. */
export async function restoreArchivedEvent(db: RelationalStore, event: Row, bundle: Row): Promise<number> {
  if (event.payload_format !== 'archived' || event.payload !== '{}'
    || event.project_id !== bundle.project_id || event.session_id !== bundle.session_id
    || event.token_id !== bundle.token_id || event.bundle_id !== bundle.id
    || !Number.isSafeInteger(event.bundle_entry) || (event.bundle_entry as number) < 0
    || (event.bundle_entry as number) >= (bundle.entry_count as number)) {
    throw new Error('an archived event and its source bundle disagree');
  }
  const columns = Object.keys(event);
  if (!columns.every(column => IDENTIFIER.test(column))) throw new Error('an archived event carries an invalid column name');
  const values = columns.map(column => event[column] ?? null);
  const match = columns.map(column => `e.${column} IS ?`).join(' AND ');
  const evidence = `EXISTS (SELECT 1 FROM archive_bundles a WHERE a.project_id=? AND a.id=?
    AND a.session_id=? AND a.token_id=? AND a.archive_key=? AND a.receipt_key=?
    AND a.digest=a.archive_key AND a.size=? AND a.entry_count>?)
    AND EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
      ON b.project_id=p.project_id AND b.key=p.key AND b.generation=p.generation
      WHERE p.project_id=? AND p.key=? AND p.source_kind='bundle' AND p.source_id=?
        AND p.event_id=? AND p.envelope_hash=? AND p.session_id=?
        AND p.digest=? AND p.size=? AND p.durable=1)
    AND EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
      ON b.project_id=p.project_id AND b.key=p.key AND b.generation=p.generation
      WHERE p.project_id=? AND p.key=? AND p.source_kind='receipt' AND p.source_id=?
        AND p.event_id=? AND p.envelope_hash=? AND p.session_id=?
        AND p.digest=? AND p.durable=1)`;
  const evidenceValues = [event.project_id,bundle.id,bundle.session_id,bundle.token_id,bundle.archive_key,
    bundle.receipt_key,bundle.size,event.bundle_entry,event.project_id,bundle.archive_key,bundle.archive_key,
    bundle.event_id,bundle.envelope_hash,bundle.session_id,bundle.archive_key,bundle.size,
    event.project_id,bundle.receipt_key,`bundle:${String(bundle.archive_key)}`,bundle.event_id,
    bundle.envelope_hash,bundle.session_id,bundle.receipt_key];
  const [inserted] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO events (${columns.join(', ')})
      SELECT ${columns.map(() => '?').join(', ')} WHERE ${evidence} RETURNING rowid`)
      .bind(...values,...evidenceValues),
    db.prepare(`INSERT INTO restore_reference_guard (missing)
      SELECT 'archived event closure' WHERE
        (NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id=? AND e.event_id=?) AND NOT (${evidence}))
        OR EXISTS (SELECT 1 FROM events e WHERE e.project_id=? AND e.event_id=?
          AND e.payload_format='archived' AND e.bundle_id=? AND NOT (${match}))`)
      .bind(event.project_id,event.event_id,...evidenceValues,event.project_id,event.event_id,event.bundle_id,...values),
  ]);
  return inserted!.results.length;
}
