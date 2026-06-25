/**
 * GET /manifest — content-addressed drift summary for symmetric reconcile.
 *
 * Allows the daemon to cheaply diff local vs cloud state per
 * (machine_id, project_id, table) partition without pulling every row.
 * Two modes:
 *
 *   summary=1  → { count } — fast aggregate for a coarse drift check
 *                 before deciding whether to page.
 *   (default)  → { items, next_cursor? } — cursor-paged { id,
 *                 project_id, content_hash? } for the daemon to diff
 *                 against local state.
 *
 * This endpoint is purely READ-ONLY. All reconcile decisions live
 * daemon-side in later tasks.
 */

import { SYNCED_TABLES } from './synced-tables';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tables that carry a `content_hash` column. Verified against schema.ts:
 * sessions, prompt_batches, spores, and plans each have `content_hash TEXT`
 * in their CREATE TABLE statement. All other synced tables do not.
 *
 * The parity assertion in manifest.test.ts keeps this constant honest:
 * it checks each member against the schema DDL so adding/removing
 * content_hash from a table is caught immediately.
 */
export const WORKER_CONTENT_HASH_TABLES = new Set<string>([
  'sessions',
  'prompt_batches',
  'spores',
  'plans',
]);

/**
 * Tables eligible for manifest reconcile: synced tables that have a
 * single `id` column (primary key). `entity_mentions` is excluded
 * because its primary key is composite (entity_id, note_id, note_type,
 * agent_id) — there is no single `id` to cursor-page on.
 */
export const MANIFEST_ELIGIBLE_TABLES = new Set<string>(
  SYNCED_TABLES.filter((t) => t !== 'entity_mentions'),
);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Public interface (D1Database subset — avoids importing the Workers runtime)
// ---------------------------------------------------------------------------

/** Minimal D1Database surface the manifest handler needs. */
export interface ManifestDb {
  prepare(sql: string): ManifestStmt;
}

interface ManifestStmt {
  bind(...values: unknown[]): ManifestStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ManifestSummaryResponse {
  table: string;
  machine_id: string;
  project_id?: string;
  count: number;
}

export interface ManifestItem {
  id: string;
  project_id: string | null;
  content_hash?: string | null;
}

export interface ManifestPageResponse {
  table: string;
  machine_id: string;
  project_id?: string;
  count: number;
  items: ManifestItem[];
  next_cursor?: string;
}

export type ManifestResponse = ManifestSummaryResponse | ManifestPageResponse;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ManifestParams {
  machineId: string;
  table: string;
  projectId: string | null;
  cursor: string | null;
  limit: number;
  summary: boolean;
}

export function parseManifestParams(url: URL): ManifestParams | { error: string; status: number } {
  const sp = url.searchParams;
  const machineId = sp.get('machine_id')?.trim() ?? '';
  if (!machineId) {
    return { error: 'machine_id is required', status: 400 };
  }

  const table = sp.get('table')?.trim() ?? '';
  if (!table) {
    return { error: 'table is required', status: 400 };
  }
  if (!MANIFEST_ELIGIBLE_TABLES.has(table)) {
    return { error: `Unknown or ineligible table: ${table}`, status: 400 };
  }

  const projectId = sp.get('project_id')?.trim() || null;
  const cursor = sp.get('cursor')?.trim() || null;
  const rawLimit = parseInt(sp.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const summary = sp.get('summary') === '1';

  return { machineId, table, projectId, cursor, limit, summary };
}

export async function queryManifest(
  db: ManifestDb,
  params: ManifestParams,
): Promise<ManifestResponse> {
  const { machineId, table, projectId, cursor, limit, summary } = params;

  if (summary) {
    const sql = projectId
      ? `SELECT COUNT(*) AS count FROM ${table} WHERE machine_id = ? AND project_id = ?`
      : `SELECT COUNT(*) AS count FROM ${table} WHERE machine_id = ?`;

    const row = await (projectId
      ? db.prepare(sql).bind(machineId, projectId)
      : db.prepare(sql).bind(machineId)
    ).first<{ count: number }>();

    return {
      table,
      machine_id: machineId,
      ...(projectId != null ? { project_id: projectId } : {}),
      count: Number(row?.count ?? 0),
    };
  }

  // Paged query: select id, project_id, and optionally content_hash.
  const hasContentHash = WORKER_CONTENT_HASH_TABLES.has(table);
  const projection = hasContentHash ? 'id, project_id, content_hash' : 'id, project_id';

  const cursorId = cursor ?? '';

  const sql = projectId
    ? `SELECT ${projection} FROM ${table} WHERE machine_id = ? AND project_id = ? AND id > ? ORDER BY id LIMIT ?`
    : `SELECT ${projection} FROM ${table} WHERE machine_id = ? AND id > ? ORDER BY id LIMIT ?`;

  const rows = await (projectId
    ? db.prepare(sql).bind(machineId, projectId, cursorId, limit + 1)
    : db.prepare(sql).bind(machineId, cursorId, limit + 1)
  ).all<ManifestItem>();

  const allItems = rows.results ?? [];
  const hasMore = allItems.length > limit;
  const items = hasMore ? allItems.slice(0, limit) : allItems;
  const nextCursor = hasMore ? String(items[items.length - 1].id) : undefined;

  // Also fetch count for the summary field on paged responses.
  const aggSql = projectId
    ? `SELECT COUNT(*) AS count FROM ${table} WHERE machine_id = ? AND project_id = ?`
    : `SELECT COUNT(*) AS count FROM ${table} WHERE machine_id = ?`;

  const aggRow = await (projectId
    ? db.prepare(aggSql).bind(machineId, projectId)
    : db.prepare(aggSql).bind(machineId)
  ).first<{ count: number }>();

  return {
    table,
    machine_id: machineId,
    ...(projectId != null ? { project_id: projectId } : {}),
    count: Number(aggRow?.count ?? 0),
    items,
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
  };
}
