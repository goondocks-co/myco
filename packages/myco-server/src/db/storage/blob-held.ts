import type { RelationalStore } from '../../core/adapters.js';
import { BLOB_REFERENCES, BUNDLE_REFERENCES, blobReferenceColumn, kindFilter, type BlobRef, type BlobReference } from '../../core/blob-references.js';
import { read, readSet } from '../index.js';

/** SQL true when a row of `ref` names blob `key` in Project `project`; both are SQL expressions in the enclosing statement. */
export function referenceHolds(ref: Omit<BlobReference, 'sinceSchema'>, project: string, key: string): string {
  return `EXISTS (SELECT 1 FROM ${ref.table} WHERE project_id = ${project} AND ${blobReferenceColumn(ref)} = ${key}${kindFilter(ref)})`;
}

/** SQL true when any row in the catalogue names blob `key` in Project `project`. Each check is scoped to `project`; a row in another Project does not hold the key. */
export const blobHeld = (project: string, key: string): string =>
  BLOB_REFERENCES.map((ref) => referenceHolds(ref, project, key)).join(' OR ');

/** SQL true when a retained event names the bundle in its Project. */
export function bundleHeld(project: string, id: string): string {
  return BUNDLE_REFERENCES.map(ref => referenceHolds(ref, project, id)).join(' OR ');
}

/**
 * Pairs one statement checks. A page travels as one JSON parameter read through `json_each`: the statement binds one
 * value and contains no compound select. The hosted store caps a compound select at five terms and bounds the
 * parameters a statement binds.
 */
const PAIRS_PER_STATEMENT = 256;

const unreferenced = read<[page: string], { p: string; k: string }>({ name: 'storage.unreferencedBlobs', sql:
  `SELECT b.p,b.k FROM (SELECT json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k FROM json_each(?1) j) b WHERE NOT (${blobHeld('b.p', 'b.k')})` });

/** Of `pairs`, those no surviving row references, each judged in its own Project, checked one page per statement in order. */
export async function unreferencedAmong(db: RelationalStore, pairs: readonly BlobRef[]): Promise<BlobRef[]> {
  const out: BlobRef[] = [];
  for (let at = 0; at < pairs.length; at += PAIRS_PER_STATEMENT) {
    const page = pairs.slice(at, at + PAIRS_PER_STATEMENT).map((b) => ({ p: b.projectId, k: b.key }));
    const [rows] = await readSet(db, unreferenced.bind(JSON.stringify(page)));
    out.push(...rows.map((r) => ({ projectId: r.p, key: r.k })));
  }
  return out;
}
