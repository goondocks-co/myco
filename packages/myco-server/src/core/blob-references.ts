/**
 * Where a blob key may be referenced, and the one check every cleanup makes.
 *
 * A blob is content-addressed and shared between rows, so it leaves the store
 * only once no surviving row names it. The rows that may name one are declared
 * by the ingest kind catalogue, never listed here: every projected blob column
 * of a kind that lands in a table, and the raw event log's key for the kinds
 * that land nowhere else. A projected kind's own event row is provenance and
 * not a reference: the projection is the reader's route to the bytes, and a
 * raw transcript segment past its window is meant to go while its event stands.
 *
 * The orphan sweep, transcript retention, session deletion and the recovery
 * snapshot check all read this catalogue, so a kind that starts naming a blob
 * is preserved by each of them the moment it enters the catalogue.
 */
import { KINDS, blobFields } from '../ingest/kinds.js';
import type { RelationalStore } from './adapters.js';

export interface BlobReference {
  table: string;
  column: string;
  /** For the raw event log: the kinds whose event row is the blob's only home. Absent on a projected column. */
  kinds?: readonly string[];
}

const projected: BlobReference[] = [...new Map(KINDS.flatMap((kind) =>
  kind.projection === 'raw' ? [] : blobFields(kind).flatMap((field) => {
    const column = kind.fields[field]!.column;
    return column === undefined ? [] : [[`${kind.projection}.${column}`, { table: kind.projection, column }] as const];
  }),
)).values()];

const rawKinds = KINDS.filter((kind) => kind.projection === 'raw' && blobFields(kind).length > 0).map((kind) => kind.name);

/** Every reference the catalogue declares, projected columns first and the raw event log last. */
export const BLOB_REFERENCES: readonly BlobReference[] = [
  ...projected,
  ...(rawKinds.length > 0 ? [{ table: 'events', column: 'blob_key', kinds: rawKinds }] : []),
];

/** The reference as a message names it: `table.column`, with the kinds a raw-log reference is limited to. */
export const referenceLabel = (ref: BlobReference): string =>
  `${ref.table}.${ref.column}${ref.kinds ? ` (${ref.kinds.join(', ')})` : ''}`;

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The SQL narrowing a reference's rows to the kinds it covers; empty for a projected column. Kind names come from the closed catalogue, so they are written as literals rather than bound. */
export const kindFilter = (ref: BlobReference): string =>
  ref.kinds ? ` AND kind IN (${ref.kinds.map(literal).join(', ')})` : '';

/** SQL true when a row of `ref` names blob `key` in Project `project`; both are SQL expressions in the enclosing statement. */
export function referenceHolds(ref: BlobReference, project: string, key: string): string {
  return `EXISTS (SELECT 1 FROM ${ref.table} WHERE project_id = ${project} AND ${ref.column} = ${key}${kindFilter(ref)})`;
}

/** SQL true when any row in the catalogue names blob `key` in Project `project`. Every check carries the Project, so a key held in one Project keeps the same content alive in no other. */
export const blobHeld = (project: string, key: string): string =>
  BLOB_REFERENCES.map((ref) => referenceHolds(ref, project, key)).join(' OR ');

export interface BlobRef { projectId: string; key: string }

/**
 * Pairs one statement checks. The page travels as one JSON parameter read
 * through `json_each`, so a statement binds one value however many pairs it
 * carries and names no compound select, which the hosted store caps at five
 * terms; the page is cut only to keep that one value small.
 */
const PAIRS_PER_STATEMENT = 256;

/** Of `pairs`, those no surviving row references, each judged in its own Project. Checked a bounded statement at a time, in order, so a page of any size is answered whole. */
export async function unreferencedAmong(db: RelationalStore, pairs: readonly BlobRef[]): Promise<BlobRef[]> {
  const out: BlobRef[] = [];
  for (let at = 0; at < pairs.length; at += PAIRS_PER_STATEMENT) {
    const page = pairs.slice(at, at + PAIRS_PER_STATEMENT).map((b) => ({ p: b.projectId, k: b.key }));
    const { results } = await db
      .prepare(`SELECT b.p, b.k FROM (SELECT json_extract(j.value, '$.p') AS p, json_extract(j.value, '$.k') AS k FROM json_each(?) j) b WHERE NOT (${blobHeld('b.p', 'b.k')})`)
      .bind(JSON.stringify(page))
      .all<{ p: string; k: string }>();
    out.push(...results.map((r) => ({ projectId: r.p, key: r.k })));
  }
  return out;
}
