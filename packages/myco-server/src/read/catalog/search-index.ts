import { SEARCH_BLOB_REFERENCED } from "../../db/search/index-queue.js";
import type { RelationalStore as core_search_index_import_RelationalStore } from "../../core/adapters.js";
import { projectsBoundOnce as core_search_index_import_projectsBoundOnce } from "../scope.js";
import type { ProjectSet as core_search_index_import_ProjectSet } from "../scope.js";

const core_search_index_REFERENCED = SEARCH_BLOB_REFERENCED;

/** The referenced text blobs the full-text index has not finished: every Project's, one Project's, or a set's. */
async function core_search_index_pendingSearchBlobs(db: core_search_index_import_RelationalStore, projects?: string | core_search_index_import_ProjectSet): Promise<number> {
  const scoped = projects === undefined ? null
    : typeof projects === 'string' ? { sql: 'q.project_id = ?', params: [projects] } : core_search_index_import_projectsBoundOnce(projects, 'q');
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM search_blob_queue q
    WHERE q.complete = 0 AND (${core_search_index_REFERENCED})${scoped === null ? '' : ` AND ${scoped.sql}`}`)
    .bind(...(scoped?.params ?? [])).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The referenced text blobs still waiting for the full-text index, and the store instant of the longest-waiting of them. */
async function core_search_index_searchBacklog(db: core_search_index_import_RelationalStore): Promise<{ pending: number; oldestStoredAt: number | null }> {
  const row = await db.prepare(`SELECT COUNT(*) AS n, MIN(b.received_at) AS oldest FROM search_blob_queue q
    JOIN blobs b ON b.project_id = q.project_id AND b.key = q.blob_key
    WHERE q.complete = 0 AND (${core_search_index_REFERENCED})`).first<{ n: number; oldest: number | null }>();
  return { pending: row?.n ?? 0, oldestStoredAt: row?.oldest ?? null };
}

export { core_search_index_pendingSearchBlobs, core_search_index_searchBacklog };
