/**
 * The inserts an additive restore writes artifact rows through. A row lists exactly the columns it carries, so each
 * table and column list is one statement shape, defined the first time a restore asks for it. Every insert is
 * `INSERT OR IGNORE`: a row the destination already holds by key is left as it stands, and RETURNING says whether
 * this row landed.
 */
import { contentGuard } from '../storage/content-guard.js';
import { write, type BindValue, type Bound } from '../index.js';
import { restoredTableStatements, restoredValues } from './restored-columns.js';

type Inserted = { rowid: number };
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedColumns(table: string, columns: readonly string[]): readonly string[] {
  if (columns.length === 0 || !columns.every(column => COLUMN.test(column))) throw new Error(`a restored ${table} row carries a column name outside the store grammar`);
  return columns;
}

const rowInserts = restoredTableStatements<Inserted, 'write'>('recovery.restoreRow');
const orderedInserts = restoredTableStatements<Inserted, 'write'>('recovery.restoreOrderedRow');
const bundleInserts = restoredTableStatements<{ id: number }, 'write'>('recovery.restoreBundle');
const transcriptInserts = restoredTableStatements<Inserted, 'write'>('recovery.restorePinned');
const proofInserts = restoredTableStatements<Inserted, 'write'>('recovery.restoreProof');
const proofGuards = restoredTableStatements<never, 'write'>('recovery.restoreProofHeld');

/** One artifact row of `table`, inserted with the columns it carries. */
export function restoredRow(table: string, row: Readonly<Record<string, unknown>>): Bound<Inserted, 'write'> {
  const columns = checkedColumns(table, Object.keys(row));
  return rowInserts(table, columns.join(','), name => write<BindValue[], Inserted>({ name, sql:
    `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')} RETURNING rowid` }))
    .bind(...restoredValues(row, columns));
}

/** The restore that claimed an insertion-ordered table, and the artifact row its next batch starts from. */
export interface RestoreOwner { table: string; hash: string; at: number }

/** One artifact row of an insertion-ordered table, inserted only while `owner` still holds the table's progress at its row. */
export function restoredOrderedRow(owner: RestoreOwner, row: Readonly<Record<string, unknown>>): Bound<Inserted, 'write'> {
  const columns = checkedColumns(owner.table, Object.keys(row));
  return orderedInserts(owner.table, columns.join(','), name => write<BindValue[], Inserted>({ name, sql:
    `INSERT OR IGNORE INTO ${owner.table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}
      WHERE EXISTS (SELECT 1 FROM backup_restore_progress WHERE table_name = ? AND artifact_hash = ? AND next_row = ?) RETURNING rowid` }))
    .bind(...restoredValues(row, columns), owner.table, owner.hash, owner.at);
}

/** An artifact archive bundle, inserted without its id: the destination numbers the bundles it holds itself. */
export function restoredBundle(row: Readonly<Record<string, unknown>>): Bound<{ id: number }, 'write'> {
  const columns = checkedColumns('archive_bundles', Object.keys(row).filter(column => column !== 'id'));
  return bundleInserts('archive_bundles', columns.join(','), name => write<BindValue[], { id: number }>({ name, sql:
    `INSERT OR IGNORE INTO archive_bundles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id` }))
    .bind(...restoredValues(row, columns));
}

/**
 * An artifact transcript, inserted with its prompt identity scheme pinned by `pin`: the scheme the row carries, the one
 * its group is admitted to over the whole artifact, or none.
 */
export function restoredTranscript(row: Readonly<Record<string, unknown>>, pin: { sql: string; params: readonly unknown[] }): Bound<Inserted, 'write'> {
  const columns = checkedColumns('transcripts', Object.keys(row).filter(column => column !== 'prompt_identity_scheme'));
  const sql = `INSERT OR IGNORE INTO transcripts (${[...columns, 'prompt_identity_scheme'].join(', ')})
        SELECT ${columns.map(() => '?').join(', ')}, ${pin.sql} RETURNING rowid`;
  return transcriptInserts('transcripts', `${columns.join(',')}|${pin.sql}`, name => write<BindValue[], Inserted>({ name, sql }))
    .bind(...restoredValues(row, columns), ...(pin.params as BindValue[]));
}

/**
 * An artifact content proof, inserted only over the blob it proves as this Deployment registers it (taking that blob's
 * generation), then a guard that fails the batch unless a proof agreeing with the row is held over that blob.
 */
export function restoredContentProof(row: Readonly<Record<string, unknown>>): [Bound<Inserted, 'write'>, Bound<never, 'write'>] {
  const columns = checkedColumns('registered_content_proofs', Object.keys(row));
  const values = columns.filter(column => column !== 'generation');
  const compared = values.filter(column => column !== 'verified_at');
  const insert = proofInserts('registered_content_proofs', columns.join(','), name => write<BindValue[], Inserted>({ name, sql:
    `INSERT OR IGNORE INTO registered_content_proofs (${columns.join(', ')})
      SELECT ${columns.map(column => column === 'generation' ? 'b.generation' : '?').join(', ')}
      FROM blobs b WHERE b.project_id = ? AND b.key = ? AND b.size = ?
        AND b.key = ? RETURNING rowid` }));
  const guard = proofGuards('registered_content_proofs', compared.join(','), name => write<BindValue[]>({ name, sql:
    `INSERT INTO restore_reference_guard (missing)
      SELECT 'registered content proof' WHERE NOT EXISTS (
        SELECT 1 FROM registered_content_proofs p JOIN blobs b
          ON b.project_id = p.project_id AND b.key = p.key AND b.generation IS p.generation
        WHERE ${compared.map(column => `p.${column} IS ?`).join(' AND ')} AND b.size = p.size)` }));
  return [
    insert.bind(...restoredValues(row, values), ...restoredValues(row, ['project_id', 'key', 'size', 'digest'])),
    guard.bind(...restoredValues(row, compared)),
  ];
}

/** Fails the batch unless the event a restored reference row names is held with the row's session and kind. */
export const referencedEventHeld = (row: Readonly<Record<string, unknown>>): Bound<never, 'write'>[] =>
  contentGuard('EXISTS (SELECT 1 FROM events WHERE project_id=? AND event_id=? AND session_id=? AND kind=?)',
    [row.project_id, row.event_id, row.session_id, row.kind]);
