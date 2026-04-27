/**
 * Embedded flag management — tracks which rows have been indexed in the external vector store.
 *
 * All vector storage and similarity search is handled by the external VectorStore.
 * This module only manages the `embedded` flag on relational tables.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tables that participate in vector embedding. */
export const EMBEDDABLE_TABLES = ['sessions', 'spores', 'plans', 'artifacts', 'skill_records', 'canopy_entries'] as const;

/**
 * Vector-store namespace identifier for the canopy_entries table. Used as a
 * discriminant by cross-cutting search/embed code paths (e.g.
 * `searchCanopy`'s `searchVectors({ namespace })` call). Distinct from the
 * SQL table identifier `canopy_entries` that appears in raw queries — those
 * intentionally remain as string literals.
 */
export const CANOPY_ENTRIES_NAMESPACE = 'canopy_entries' as const;

/** TypeScript type for valid embeddable table names. */
export type EmbeddableTable = (typeof EMBEDDABLE_TABLES)[number];

/** Per-table column that holds the text content used for embedding. */
export const EMBEDDABLE_TEXT_COLUMNS: Record<EmbeddableTable, string> = {
  sessions: 'summary',
  spores: 'content',
  plans: 'content',
  artifacts: 'content',
  skill_records: 'description',
  canopy_entries: 'llm_description',
};

/** Error message for invalid table names. */
const INVALID_TABLE_MSG = 'Invalid table name — must be one of: sessions, spores, plans, artifacts, skill_records, canopy_entries';

/** Default number of rows returned by getUnembedded. */
const DEFAULT_UNEMBEDDED_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a table name is in the allowlist.
 *
 * @throws if the table name is not one of the embeddable tables.
 */
export function assertValidTable(table: string): asserts table is EmbeddableTable {
  if (!(EMBEDDABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(INVALID_TABLE_MSG);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Mark a row as embedded in the external vector store. */
export function markEmbedded(table: string, id: string | number): void {
  assertValidTable(table);
  const db = getDatabase();
  db.prepare(`UPDATE ${table} SET embedded = 1 WHERE id = ?`).run(id);
}

/** Clear the embedded flag (e.g., when vector is removed or needs re-embedding). */
export function clearEmbedded(table: string, id: string | number): void {
  assertValidTable(table);
  const db = getDatabase();
  db.prepare(`UPDATE ${table} SET embedded = 0 WHERE id = ?`).run(id);
}

/** Find rows that have not yet been embedded, oldest first. */
export function getUnembedded(
  table: string,
  limit: number = DEFAULT_UNEMBEDDED_LIMIT,
): Array<{ id: string | number; created_at: number; text: string }> {
  assertValidTable(table);
  const db = getDatabase();
  const textCol = EMBEDDABLE_TEXT_COLUMNS[table as EmbeddableTable];

  if (table === 'canopy_entries') {
    return db.prepare(
      `SELECT (project_id || ':' || path) AS id,
              mechanical_updated_at AS created_at,
              ${textCol} AS text
         FROM canopy_entries
        WHERE embedded = 0
          AND llm_description IS NOT NULL
        ORDER BY mechanical_updated_at ASC
        LIMIT ?`,
    ).all(limit) as Array<{ id: string; created_at: number; text: string }>;
  }

  const contentFilter = table === 'sessions' ? ' AND summary IS NOT NULL' : '';
  const statusFilter = (table === 'spores' || table === 'skill_records') ? " AND status = 'active'" : '';

  return db.prepare(
    `SELECT id, created_at, ${textCol} AS text
     FROM ${table}
     WHERE embedded = 0${contentFilter}${statusFilter}
     ORDER BY created_at ASC
     LIMIT ?`
  ).all(limit) as Array<{ id: string | number; created_at: number; text: string }>;
}

/** Get aggregated embedding queue depth across all embeddable tables. */
export function getEmbeddingQueueDepth(): {
  queue_depth: number;
  embedded_count: number;
  total: number;
} {
  const db = getDatabase();

  const queueRow = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions       WHERE embedded = 0 AND summary IS NOT NULL) +
      (SELECT COUNT(*) FROM spores         WHERE embedded = 0 AND status = 'active') +
      (SELECT COUNT(*) FROM plans          WHERE embedded = 0 AND content IS NOT NULL) +
      (SELECT COUNT(*) FROM artifacts      WHERE embedded = 0 AND content IS NOT NULL) +
      (SELECT COUNT(*) FROM skill_records  WHERE embedded = 0 AND status = 'active') +
      (SELECT COUNT(*) FROM canopy_entries WHERE embedded = 0 AND llm_description IS NOT NULL)
    AS cnt
  `).get() as { cnt: number };

  const embeddedRow = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions       WHERE embedded = 1) +
      (SELECT COUNT(*) FROM spores         WHERE embedded = 1) +
      (SELECT COUNT(*) FROM plans          WHERE embedded = 1) +
      (SELECT COUNT(*) FROM artifacts      WHERE embedded = 1) +
      (SELECT COUNT(*) FROM skill_records  WHERE embedded = 1) +
      (SELECT COUNT(*) FROM canopy_entries WHERE embedded = 1)
    AS cnt
  `).get() as { cnt: number };

  const queue_depth = Number(queueRow.cnt ?? 0);
  const embedded_count = Number(embeddedRow.cnt ?? 0);
  return { queue_depth, embedded_count, total: queue_depth + embedded_count };
}
