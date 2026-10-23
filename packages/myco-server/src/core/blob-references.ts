/**
 * The blob reference catalogue and the held check every cleanup makes.
 *
 * A blob leaves the store only once no surviving row names it. The rows that
 * may name one are derived from the ingest kind catalogue: every projected
 * blob column, and the raw event log's key for the kinds with no projection.
 * A projected kind's own event row is not a reference; the projection is the
 * reader's route to the bytes, and a raw transcript segment past its window
 * is removed while its event row stands.
 *
 * Read by the orphan sweep, transcript retention, session deletion and the
 * recovery snapshot check.
 */
import { VIEW_BLOB_REFERENCES } from '../db/view-tables.js';
import { KINDS, blobFields } from '../ingest/kinds.js';
import type { RelationalStore } from './adapters.js';

export interface BlobReference {
  table: string;
  column: string;
  /** First snapshot schema version that must contain this table. */
  sinceSchema: number;
  /** For the raw event log: the kinds whose event row is the blob's only home. Absent on a projected column. */
  kinds?: readonly string[];
}

type ReferenceColumns = Omit<BlobReference, 'sinceSchema'>;
const COMPLETE_REFERENCE_SCHEMA = 75;
const VIEW_REFERENCE_SCHEMA = 100;
const atSchema = (sinceSchema: number, refs: readonly ReferenceColumns[]): BlobReference[] =>
  refs.map(ref => ({ ...ref, sinceSchema }));

const projected: ReferenceColumns[] = [...new Map(KINDS.flatMap((kind) =>
  kind.projection === 'raw' ? [] : blobFields(kind).flatMap((field) => {
    const column = kind.fields[field]!.column;
    return column === undefined ? [] : [[`${kind.projection}.${column}`, { table: kind.projection, column }] as const];
  }),
)).values()];

const rawKinds = KINDS.filter((kind) => kind.projection === 'raw' && blobFields(kind).length > 0).map((kind) => kind.name);

/** Every reference the catalogue declares, projected columns first and the raw event log last. */
export const BLOB_REFERENCES: readonly BlobReference[] = [
  ...atSchema(COMPLETE_REFERENCE_SCHEMA, projected),
  ...atSchema(VIEW_REFERENCE_SCHEMA, VIEW_BLOB_REFERENCES),
  ...atSchema(COMPLETE_REFERENCE_SCHEMA, [
    ...(rawKinds.length > 0 ? [{ table: 'events', column: 'blob_key', kinds: rawKinds }] : []),
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
  { table: 'tool_calls', column: 'input_bundle_id' },
  { table: 'view_tool_calls', column: 'input_bundle_id' },
];

/** The reference as a message names it: `table.column`, with the kinds a raw-log reference is limited to. */
export const referenceLabel = (ref: BlobReference): string =>
  `${ref.table}.${ref.column}${ref.kinds ? ` (${ref.kinds.join(', ')})` : ''}`;

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The SQL narrowing a reference's rows to the kinds it covers; empty for a projected column. Kind names are catalogue constants, written as SQL literals. */
export const kindFilter = (ref: ReferenceColumns): string =>
  ref.kinds ? ` AND kind IN (${ref.kinds.map(literal).join(', ')})` : '';

/** SQL true when a row of `ref` names blob `key` in Project `project`; both are SQL expressions in the enclosing statement. */
export function referenceHolds(ref: ReferenceColumns, project: string, key: string, identity?: { column: string; value: string }): string {
  const scope = identity === undefined ? '' : ` AND ${identity.column} = ${identity.value}`;
  return `EXISTS (SELECT 1 FROM ${ref.table} WHERE project_id = ${project} AND ${ref.column} = ${key}${kindFilter(ref)}${scope})`;
}

/** SQL true when any row in the catalogue names blob `key` in Project `project`. Each check is scoped to `project`; a row in another Project does not hold the key. */
export const blobHeld = (project: string, key: string): string =>
  BLOB_REFERENCES.map((ref) => referenceHolds(ref, project, key)).join(' OR ');

/** Singleton bundles have one stored source identity; view holders span every instance. */
export function bundleHeld(project: string, id: string, singleton?: { eventId: string; toolCallId: string }): string {
  const identities: Record<string, { column: string; value: string }> = singleton === undefined ? {} : {
    events: { column: 'event_id', value: singleton.eventId },
    tool_calls: { column: 'tool_call_id', value: singleton.toolCallId },
  };
  return BUNDLE_REFERENCES.map(ref => referenceHolds(ref, project, id, identities[ref.table])).join(' OR ');
}

export interface BlobRef { projectId: string; key: string }

/**
 * Pairs one statement checks. A page travels as one JSON parameter read
 * through `json_each`: the statement binds one value and contains no compound
 * select. The hosted store caps a compound select at five terms and bounds the
 * parameters a statement binds.
 */
const PAIRS_PER_STATEMENT = 256;

/** Of `pairs`, those no surviving row references, each judged in its own Project, checked one page per statement in order. */
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
