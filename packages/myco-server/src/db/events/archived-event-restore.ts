/**
 * Importing an archived event: the event lands only while its exact bundle and the bundle's publication evidence are
 * held, and an event already present under its id must match the restored row column for column.
 */
import { isArchivedEventMetadata } from '../document-tables.js';
import { write, type BindValue, type Bound } from '../index.js';
import { restoredColumnStatements, restoredValues } from '../recovery/restored-columns.js';

type Row = Readonly<Record<string, unknown>>;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const EVIDENCE = `EXISTS (SELECT 1 FROM archive_bundles a WHERE a.project_id=? AND a.id=?
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

const inserts = restoredColumnStatements<{ rowid: number }, 'write'>('events.restoreArchived');
const closures = restoredColumnStatements<never, 'write'>('events.restoreArchivedClosure');

/**
 * The insert, then the closure guard that aborts the batch when the event is neither held as restored nor admissible.
 * The insert answers a row only where it added the event.
 */
export function archivedEventRestore(event: Row, bundle: Row): [insert: Bound<{ rowid: number }, 'write'>, closure: Bound<never, 'write'>] {
  if (event.payload_format !== 'archived' || !isArchivedEventMetadata(event.payload)
    || event.project_id !== bundle.project_id || event.session_id !== bundle.session_id
    || event.token_id !== bundle.token_id || event.bundle_id !== bundle.id
    || !Number.isSafeInteger(event.bundle_entry) || (event.bundle_entry as number) < 0
    || (event.bundle_entry as number) >= (bundle.entry_count as number)) {
    throw new Error('an archived event and its source bundle disagree');
  }
  const columns = Object.keys(event);
  if (!columns.every(column => IDENTIFIER.test(column))) throw new Error('an archived event carries an invalid column name');
  const values = restoredValues(event, columns);
  const evidenceValues = [event.project_id, bundle.id, bundle.session_id, bundle.token_id, bundle.archive_key,
    bundle.receipt_key, bundle.size, event.bundle_entry, event.project_id, bundle.archive_key, bundle.archive_key,
    bundle.event_id, bundle.envelope_hash, bundle.session_id, bundle.archive_key, bundle.size,
    event.project_id, bundle.receipt_key, `bundle:${String(bundle.archive_key)}`, bundle.event_id,
    bundle.envelope_hash, bundle.session_id, bundle.receipt_key].map(value => (value ?? null) as BindValue);
  const insert = inserts(columns, (name, list) => write<BindValue[], { rowid: number }>({ name, sql:
    `INSERT OR IGNORE INTO events (${list.join(', ')})
      SELECT ${list.map(() => '?').join(', ')} WHERE ${EVIDENCE} RETURNING rowid` }));
  const closure = closures(columns, (name, list) => write<BindValue[]>({ name, sql:
    `INSERT INTO restore_reference_guard (missing)
      SELECT 'archived event closure' WHERE
        (NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id=? AND e.event_id=?) AND NOT (${EVIDENCE}))
        OR EXISTS (SELECT 1 FROM events e WHERE e.project_id=? AND e.event_id=?
          AND e.payload_format='archived' AND e.bundle_id=? AND NOT (${list.map(column => `e.${column} IS ?`).join(' AND ')}))` }));
  const id = (value: unknown) => (value ?? null) as BindValue;
  return [insert.bind(...values, ...evidenceValues),
    closure.bind(id(event.project_id), id(event.event_id), ...evidenceValues, id(event.project_id), id(event.event_id), id(event.bundle_id), ...values)];
}
