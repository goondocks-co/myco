import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, type Bound } from '../index.js';
import { SEARCH_DOCUMENTS_CATCHUP } from './catchup.js';

/**
 * Reads of the search projection. A window is a bounded walk of one full-text expression's matches by `doc_id`, newest
 * or oldest first; presence lookups test one expression against a list of `doc_id`s. None of them ranks inside the
 * full-text index. `hydration.ts` reads a page's documents back with their records.
 */

const newest = read<[match: string, low: number, high: number, limit: number], { doc_id: number }>({ name: 'searchDocuments.windowNewest',
  sql: 'SELECT rowid AS doc_id FROM search_documents_fts WHERE search_documents_fts MATCH ?1 AND rowid >= ?2 AND rowid <= ?3 ORDER BY rowid DESC LIMIT ?4' });
const oldest = read<[match: string, low: number, high: number, limit: number], { doc_id: number }>({ name: 'searchDocuments.windowOldest',
  sql: 'SELECT rowid AS doc_id FROM search_documents_fts WHERE search_documents_fts MATCH ?1 AND rowid >= ?2 AND rowid <= ?3 ORDER BY rowid LIMIT ?4' });
const present = read<[match: string, ids: string], { doc_id: number }>({ name: 'searchDocuments.present',
  sql: 'SELECT rowid AS doc_id FROM search_documents_fts WHERE search_documents_fts MATCH ?1 AND rowid IN (SELECT value FROM json_each(?2))' });

/** One window: up to `limit` matches of `match` with `doc_id` in `[low, high]`, newest or oldest first. */
export interface WindowRead { match: string; low: number; high: number; limit: number; direction: 'newest' | 'oldest' }

/** Each window's `doc_id`s and, after them, each presence lookup's `doc_id`s, in one read set. */
export async function readWindows(db: RelationalStore, windows: readonly WindowRead[], lookups: readonly { match: string; ids: readonly number[] }[] = []): Promise<{ windows: number[][]; lookups: Set<number>[] }> {
  const bound: Bound<{ doc_id: number }, 'read'>[] = [
    ...windows.map((w) => (w.direction === 'newest' ? newest : oldest).bind(w.match, w.low, w.high, w.limit)),
    ...lookups.map((l) => present.bind(l.match, JSON.stringify(l.ids))),
  ];
  if (bound.length === 0) return { windows: [], lookups: [] };
  const rows = await readSet(db, ...bound);
  return {
    windows: rows.slice(0, windows.length).map((found) => found.map((row) => Number(row.doc_id))),
    lookups: rows.slice(windows.length).map((found) => new Set(found.map((row) => Number(row.doc_id)))),
  };
}

const docPlans = read<[ids: string], { doc_id: number; plan: string }>({ name: 'searchDocuments.docPlans',
  sql: `SELECT d.doc_id, json_array(d.project_id, d.source_key) AS plan FROM json_each(?1) j CROSS JOIN search_documents d ON d.doc_id = j.value WHERE d.kind = 'plan'
    UNION ALL SELECT d.doc_id, json_array(r.project_id, r.plan_key) AS plan FROM json_each(?1) j CROSS JOIN search_documents d ON d.doc_id = j.value
      CROSS JOIN search_blob_refs r ON r.project_id = d.project_id AND r.blob_key = d.blob_key WHERE d.kind = 'chunk'` });

/** The plans each plan or chunk document of `ids` belongs to: a chunk belongs to every plan whose proved body it is part of. */
export async function plansOfDocuments(db: RelationalStore, ids: readonly number[]): Promise<Map<number, string[]>> {
  const plans = new Map<number, string[]>();
  if (ids.length === 0) return plans;
  const [rows] = await readSet(db, docPlans.bind(JSON.stringify(ids)));
  for (const row of rows) plans.set(Number(row.doc_id), [...(plans.get(Number(row.doc_id)) ?? []), JSON.stringify(JSON.parse(row.plan))]);
  return plans;
}

const ordering = read<[ids: string], { doc_id: number; record_at: number; kind: string; source_key: string }>({ name: 'searchDocuments.ordering',
  sql: 'SELECT d.doc_id, d.record_at, d.kind, d.source_key FROM json_each(?1) j CROSS JOIN search_documents d ON d.doc_id = j.value' });

/** Each document's record instant and identity, which order documents of equal score: newest first, then by identity. */
export async function documentOrdering(db: RelationalStore, ids: readonly number[]): Promise<Map<number, { at: number; key: string }>> {
  if (ids.length === 0) return new Map();
  const [rows] = await readSet(db, ordering.bind(JSON.stringify(ids)));
  return new Map(rows.map((row) => [Number(row.doc_id), { at: Number(row.record_at), key: JSON.stringify([row.kind, row.source_key]) }]));
}

const planDocs = read<[plans: string], { doc_id: number; kind: 'plan' | 'chunk'; plan: string }>({ name: 'searchDocuments.planDocs',
  sql: `SELECT d.doc_id, d.kind, j.value AS plan FROM json_each(?1) j CROSS JOIN search_documents d
      ON d.project_id = json_extract(j.value, '$[0]') AND d.kind = 'plan' AND d.source_key = json_extract(j.value, '$[1]')
    UNION ALL SELECT d.doc_id, d.kind, j.value AS plan FROM json_each(?1) j
      CROSS JOIN search_blob_refs r ON r.project_id = json_extract(j.value, '$[0]') AND r.plan_key = json_extract(j.value, '$[1]')
      CROSS JOIN search_documents d ON d.project_id = r.project_id AND d.blob_key = r.blob_key AND d.kind = 'chunk'` });

/** Every document of each plan in `plans` (as `[project, plan_key]`): its own, and each chunk of its proved body. */
export async function documentsOfPlans(db: RelationalStore, plans: readonly string[]): Promise<{ doc_id: number; kind: 'plan' | 'chunk'; plan: string }[]> {
  if (plans.length === 0) return [];
  const [rows] = await readSet(db, planDocs.bind(`[${plans.join(',')}]`));
  return rows.map((row) => ({ ...row, doc_id: Number(row.doc_id), plan: JSON.stringify(JSON.parse(row.plan)) }));
}

const phases = read<[], { phases: number; done: number | null }>({ name: 'searchDocuments.readiness',
  sql: `SELECT COUNT(*) AS phases, MIN(done) AS done FROM projection_catchup WHERE projection = '${SEARCH_DOCUMENTS_CATCHUP.projection}'` });

/** `ready` once every phase of the search projection's catch-up has finished; a phase not yet seeded is not finished. */
export async function searchIndexReadiness(db: RelationalStore): Promise<'ready' | 'building'> {
  const [rows] = await readSet(db, phases.bind());
  const held = rows[0];
  return held !== undefined && Number(held.phases) === Object.keys(SEARCH_DOCUMENTS_CATCHUP.phases).length && held.done === 1 ? 'ready' : 'building';
}

const visibleProjects = read<[], { project_id: string }>({ name: 'searchDocuments.visibleProjects', sql: 'SELECT project_id FROM projects WHERE archived_at IS NULL ORDER BY project_id' });
const namedProjects = read<[ids: string], { project_id: string }>({ name: 'searchDocuments.namedProjects',
  sql: 'SELECT project_id FROM projects WHERE project_id IN (SELECT value FROM json_each(?1)) ORDER BY project_id' });

/** The Projects a search covers right now: every Project accepting capture, or those of `named` that exist. */
export async function reachProjects(db: RelationalStore, named: readonly string[] | null): Promise<string[]> {
  const [rows] = await readSet(db, named === null ? visibleProjects.bind() : namedProjects.bind(JSON.stringify(named)));
  return rows.map((row) => row.project_id);
}
