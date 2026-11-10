import { changed, jsonKeys, trigger } from '../ddl.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { processedResourceProofSql } from '../processed-resources.js';
import { write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';
import { SEARCH_DOCUMENTS_PROJECTION } from './documents-schema.js';

/**
 * Which stored plan bodies the search index reads. A plan whose body is stored apart references its blob once the body
 * carries a `processed` proof; `search_blob_refs` holds exactly those references, re-derived from the plan and its proof
 * whenever either changes. `search_blobs` is one row per referenced blob: how many proved references it has, whether
 * its text is waiting, read, or leaving the index, the generation every such move advances, and where the next pass
 * resumes. `search_index_status` counts the blobs waiting per Project, moved by each blob's own state change.
 *
 * A blob is waiting (`pending`) or leaving (`retiring`) exactly while its row is not `indexed`, and a blob with no
 * reference is always `retiring`: one predicate selects the work, the due index and the count.
 */
const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

/** The blob work the indexer takes and the backlog counts: every row not yet `indexed`. */
export const SEARCH_BLOB_WORK = `state <> 'indexed'`;

/** Re-derive the proved blob references of the plan keys `keys` (columns `project_id, plan_key`). */
function reconcileReferences(keys: string): string[] {
  return [
    `DELETE FROM search_blob_refs WHERE (project_id, plan_key) IN (SELECT project_id, plan_key FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.project_id = search_blob_refs.project_id AND p.plan_key = search_blob_refs.plan_key
        AND p.blob_key = search_blob_refs.blob_key AND ${processedResourceProofSql('p.project_id', 'plan', 'p.plan_key', 'p.blob_key')})`,
    `INSERT INTO search_blob_refs(project_id, plan_key, blob_key)
      SELECT p.project_id, p.plan_key, p.blob_key FROM (${keys}) k CROSS JOIN plans p ON p.project_id = k.project_id AND p.plan_key = k.plan_key
      WHERE p.blob_key IS NOT NULL AND ${processedResourceProofSql('p.project_id', 'plan', 'p.plan_key', 'p.blob_key')}
      ON CONFLICT(project_id, plan_key) DO NOTHING`,
  ].map((sql) => sql.replace(/\s+/g, ' '));
}

export const SEARCH_BLOB_REFERENCE_PHASE = {
  searchBlobRefs: {
    source: { table: 'plans', columns: ['project_id', 'plan_key'], unique: true },
    reconcile: reconcileReferences(jsonKeys(['project_id', 'plan_key'])).map((sql, i) => write<[string]>({ name: `searchDocuments.blobRefsPage${i}`, sql })),
  },
} as const satisfies CatchupFamily['phases'];

const planKeys = (row: 'NEW' | 'OLD') => `SELECT ${row}.project_id AS project_id, ${row}.plan_key AS plan_key`;
const proofKeys = (row: 'NEW' | 'OLD') => `SELECT ${row}.project_id AS project_id, ${row}.resource_id AS plan_key`;

/**
 * A blob gaining a proved reference: a new row waits since its bytes were stored; a leaving one waits again from its
 * start, under a new generation, from now.
 */
const referenceArrives = `INSERT INTO search_blobs(project_id, blob_key, live_refs, state, generation, next_byte, due_at, pending_since)
  VALUES (NEW.project_id, NEW.blob_key, 1, 'pending', 0, 0, 0,
    COALESCE((SELECT received_at FROM blobs WHERE project_id = NEW.project_id AND key = NEW.blob_key), ${NOW_MS}))
  ON CONFLICT(project_id, blob_key) DO UPDATE SET live_refs = live_refs + 1,
    next_byte = CASE WHEN state = 'retiring' THEN 0 ELSE next_byte END,
    generation = CASE WHEN state = 'retiring' THEN generation + 1 ELSE generation END,
    due_at = CASE WHEN state = 'retiring' THEN 0 ELSE due_at END,
    pending_since = CASE WHEN state = 'retiring' THEN ${NOW_MS} ELSE pending_since END,
    state = CASE WHEN state = 'retiring' THEN 'pending' ELSE state END`;

/** A blob losing its last proved reference leaves the index under a new generation, so no pass in flight can commit. */
const referenceLeaves = `UPDATE search_blobs SET live_refs = live_refs - 1,
    generation = CASE WHEN live_refs = 1 THEN generation + 1 ELSE generation END,
    due_at = CASE WHEN live_refs = 1 THEN 0 ELSE due_at END,
    state = CASE WHEN live_refs = 1 THEN 'retiring' ELSE state END
  WHERE project_id = OLD.project_id AND blob_key = OLD.blob_key`;

const countMove = (project: string, delta: string) => `INSERT INTO search_index_status(project_id, pending) VALUES (${project}, ${delta})
  ON CONFLICT(project_id) DO UPDATE SET pending = pending + (${delta})`;

/** The reference, blob and count tables, their triggers and the catch-up seed, as one schema step freezes them. */
export function searchBlobIndexStatements(): string[] {
  const watchedPlan = ['project_id', 'plan_key', 'blob_key'];
  const watchedProof = ['project_id', 'kind', 'resource_id', 'blob_key', 'classification'];
  return [
    `CREATE TABLE IF NOT EXISTS search_blob_refs(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), plan_key TEXT NOT NULL, blob_key TEXT NOT NULL,
      PRIMARY KEY(project_id, plan_key)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_search_blob_refs_blob ON search_blob_refs(project_id, blob_key)',
    `CREATE TABLE IF NOT EXISTS search_blobs(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), blob_key TEXT NOT NULL,
      live_refs INTEGER NOT NULL CHECK (live_refs >= 0), state TEXT NOT NULL CHECK (state IN ('pending','indexed','retiring')),
      generation INTEGER NOT NULL DEFAULT 0, claim INTEGER NOT NULL DEFAULT 0, next_byte INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL DEFAULT 0, pending_since INTEGER, failures INTEGER NOT NULL DEFAULT 0, failure TEXT,
      PRIMARY KEY(project_id, blob_key)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS idx_search_blobs_due ON search_blobs(due_at, project_id, blob_key) WHERE ${SEARCH_BLOB_WORK}`,
    `CREATE INDEX IF NOT EXISTS idx_search_blobs_waiting ON search_blobs(pending_since) WHERE state = 'pending'`,
    `CREATE TABLE IF NOT EXISTS search_index_status(project_id TEXT NOT NULL PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}), pending INTEGER NOT NULL) WITHOUT ROWID`,
    trigger('search_blob_refs_plan_insert', 'plans', 'INSERT', reconcileReferences(planKeys('NEW')), 'NEW.blob_key IS NOT NULL').sql,
    trigger('search_blob_refs_plan_update', 'plans', `UPDATE OF ${watchedPlan.join(', ')}`,
      reconcileReferences(`${planKeys('OLD')} UNION ${planKeys('NEW')}`), changed(watchedPlan)).sql,
    trigger('search_blob_refs_plan_delete', 'plans', 'DELETE', reconcileReferences(planKeys('OLD')), 'OLD.blob_key IS NOT NULL').sql,
    trigger('search_blob_refs_proof_insert', 'processed_resources', 'INSERT', reconcileReferences(proofKeys('NEW')), `NEW.kind = 'plan'`).sql,
    trigger('search_blob_refs_proof_update', 'processed_resources', `UPDATE OF ${watchedProof.join(', ')}`,
      reconcileReferences(`${proofKeys('OLD')} UNION ${proofKeys('NEW')}`), `(OLD.kind = 'plan' OR NEW.kind = 'plan') AND (${changed(watchedProof)})`).sql,
    trigger('search_blob_refs_proof_delete', 'processed_resources', 'DELETE', reconcileReferences(proofKeys('OLD')), `OLD.kind = 'plan'`).sql,
    trigger('search_blob_refs_insert', 'search_blob_refs', 'INSERT', [referenceArrives]).sql,
    trigger('search_blob_refs_delete', 'search_blob_refs', 'DELETE', [referenceLeaves]).sql,
    trigger('search_blobs_count_insert', 'search_blobs', 'INSERT', [countMove('NEW.project_id', `NEW.state = 'pending'`)]).sql,
    trigger('search_blobs_count_update', 'search_blobs', 'UPDATE OF state', [countMove('NEW.project_id', `(NEW.state = 'pending') - (OLD.state = 'pending')`)], 'OLD.state IS NOT NEW.state').sql,
    trigger('search_blobs_count_delete', 'search_blobs', 'DELETE', [countMove('OLD.project_id', `-(OLD.state = 'pending')`)]).sql,
    `INSERT INTO projection_catchup(projection, phase, done) SELECT '${SEARCH_DOCUMENTS_PROJECTION}', 'searchBlobRefs', NOT EXISTS (SELECT 1 FROM plans)`,
  ].map((sql) => sql.replace(/\s+/g, ' '));
}
