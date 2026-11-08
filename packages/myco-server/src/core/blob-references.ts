/**
 * The blob reference catalogue and the held check every cleanup makes.
 *
 * A blob leaves the store only once no surviving row names it. The rows that
 * may name one include projected blob columns, raw event keys and retained
 * event payload references. Transcript segments release their blob keys when
 * the raw retention window expires.
 *
 * Read by the orphan sweep, transcript retention, session deletion and the
 * recovery snapshot check; the held check itself is `db/storage/blob-held.ts`.
 */
import { KINDS, blobFields } from '../ingest/kinds.js';

export interface BlobReference {
  table: string;
  column: string;
  /** First snapshot schema version that must contain this table. */
  sinceSchema: number;
  /** For the raw event log: the kinds whose retained event independently holds its blob. Absent on a projected column. */
  kinds?: readonly string[];
  /** Missing retained capture is reported during recovery; reference writers still require registered content. */
  onMissing?: 'report';
}

type ReferenceColumns = Omit<BlobReference, 'sinceSchema'>;
const COMPLETE_REFERENCE_SCHEMA = 75;
const atSchema = (sinceSchema: number, refs: readonly ReferenceColumns[]): BlobReference[] =>
  refs.map(ref => ({ ...ref, sinceSchema }));

const projected: ReferenceColumns[] = [...new Map(KINDS.flatMap((kind) =>
  ['raw','prompt_batches','responses','tool_calls'].includes(kind.projection) ? [] : blobFields(kind).flatMap((field) => {
    const column = kind.fields[field]!.column;
    return column === undefined ? [] : [[`${kind.projection}.${column}`, { table: kind.projection, column }] as const];
  }),
)).values()];

const retainedKinds = KINDS.filter((kind) => blobFields(kind).length > 0).map((kind) => kind.name);

/** Every reference the catalogue declares, projected columns first and the raw event log last. */
export const BLOB_REFERENCES: readonly BlobReference[] = [
  ...atSchema(COMPLETE_REFERENCE_SCHEMA, projected),
  ...atSchema(117,[{table:'event_refs',column:'blob',onMissing:'report'},{table:'event_refs',column:'output_blob',onMissing:'report'}]),
  ...atSchema(COMPLETE_REFERENCE_SCHEMA, [
    ...(retainedKinds.length > 0 ? [{ table: 'events', column: 'blob_key', kinds: retainedKinds, onMissing: 'report' as const }] : []),
    { table: 'archive_bundles', column: 'archive_key' },
    { table: 'archive_bundles', column: 'receipt_key' },
    { table: 'raw_archive_refs', column: 'archive_key' },
    { table: 'raw_archive_refs', column: 'receipt_key' },
    { table: 'registered_content_proofs', column: 'key' },
  ]),
];

/** Physical rows that retain an archive bundle in their Project. */
export const BUNDLE_REFERENCES: readonly ReferenceColumns[] = [
  { table: 'events', column: 'bundle_id' },
];

/** The stored key selected by one declared reference. */
export function blobReferenceColumn(ref: ReferenceColumns, alias?: string): string {
  const column=alias===undefined?ref.column:`${alias}.${ref.column}`;
  return column;
}
export function referencedBlobValue(ref: ReferenceColumns, row: Readonly<Record<string,unknown>>): unknown {
  const value=row[ref.column];
  return value;
}

/** The reference as a message names it: `table.column`, with the kinds a raw-log reference is limited to. */
export const referenceLabel = (ref: BlobReference): string =>
  `${ref.table}.${ref.column}${ref.kinds ? ` (${ref.kinds.join(', ')})` : ''}`;

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The SQL narrowing a reference's rows to the kinds it covers; empty for a projected column. Kind names are catalogue constants, written as SQL literals. */
export const kindFilter = (ref: ReferenceColumns): string =>
  ref.kinds ? ` AND kind IN (${ref.kinds.map(literal).join(', ')})` : '';

export interface BlobRef { projectId: string; key: string }
