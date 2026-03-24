/**
 * pgvector embedding query helpers — store, search, and find unembedded rows.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Table name parameters are validated against the allowlist `EMBEDDABLE_TABLES`
 * to prevent SQL injection (table names cannot be parameterized).
 */

import { getDatabase } from '@myco/db/client.js';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tables that have an `embedding vector(N)` column. */
export const EMBEDDABLE_TABLES = ['sessions', 'spores', 'plans', 'artifacts'] as const;

/** TypeScript type for valid embeddable table names. */
export type EmbeddableTable = (typeof EMBEDDABLE_TABLES)[number];

/** Default number of results returned by searchSimilar. */
const DEFAULT_SEARCH_LIMIT = 20;

/** Default number of rows returned by getUnembedded. */
const DEFAULT_UNEMBEDDED_LIMIT = 100;

/** Error message for invalid table names. */
const INVALID_TABLE_MSG = 'Invalid table name — must be one of: sessions, spores, plans, artifacts';

/** Error message when setEmbedding finds no matching row. */
const NO_ROW_MSG = 'No row found with the given id';

/**
 * Per-table column lists that exclude the embedding column.
 * Used by searchSimilar to avoid returning large vector data in results.
 */
const TABLE_SELECT_COLUMNS: Record<EmbeddableTable, string> = {
  sessions: [
    'id', 'agent', '"user"', 'project_root', 'branch', 'started_at', 'ended_at',
    'status', 'prompt_count', 'tool_count', 'title', 'summary', 'transcript_path',
    'parent_session_id', 'parent_session_reason', 'processed', 'content_hash', 'created_at',
  ].join(', '),
  spores: [
    'id', 'agent_id', 'session_id', 'prompt_batch_id', 'observation_type',
    'status', 'content', 'context', 'importance', 'file_path', 'tags',
    'content_hash', 'created_at', 'updated_at',
  ].join(', '),
  plans: [
    'id', 'status', 'author', 'title', 'content', 'source_path',
    'tags', 'processed', 'created_at', 'updated_at',
  ].join(', '),
  artifacts: [
    'id', 'artifact_type', 'source_path', 'title', 'content',
    'last_captured_by', 'tags', 'created_at', 'updated_at',
  ].join(', '),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row returned from similarity search — the original row columns plus similarity score. */
export interface SimilarityResult {
  id: string;
  similarity: number;
  [key: string]: unknown;
}

/** Options for searchSimilar. */
export interface SearchSimilarOptions {
  limit?: number;
  filters?: Record<string, unknown>;
}

/** Options for getUnembedded. */
export interface GetUnembeddedOptions {
  limit?: number;
}

/** A row returned from getUnembedded — just id and created_at for the embedding worker. */
export interface UnembeddedRow {
  id: string | number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a table name is in the allowlist.
 *
 * @throws if the table name is not one of the embeddable tables.
 */
function assertValidTable(table: string): asserts table is EmbeddableTable {
  if (!(EMBEDDABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(INVALID_TABLE_MSG);
  }
}

/**
 * Format a number[] as a pgvector literal string: `[0.1, 0.2, ...]`.
 *
 * pgvector expects vector values as string literals in this format.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store an embedding vector on an existing row.
 *
 * UPDATE <table> SET embedding = $vec WHERE id = $id.
 *
 * @param table — one of 'sessions', 'spores', 'plans', 'artifacts'
 * @param id — the primary key of the row to update
 * @param embedding — a number[] of length EMBEDDING_DIMENSIONS
 * @throws if the table name is invalid or no row matches the id
 */
export async function setEmbedding(
  table: string,
  id: string | number,
  embedding: number[],
): Promise<void> {
  assertValidTable(table);

  const db = getDatabase();
  const vecLiteral = toVectorLiteral(embedding);

  // The embedding column is set via a cast from the string literal.
  // We use string interpolation for the table name (validated above)
  // and parameterized placeholders for the values.
  const result = await db.query(
    `UPDATE ${table}
     SET embedding = $1::vector(${EMBEDDING_DIMENSIONS})
     WHERE id = $2`,
    [vecLiteral, id],
  );

  if (result.affectedRows === 0) {
    throw new Error(NO_ROW_MSG);
  }
}

/**
 * Search for rows similar to a query vector using cosine distance.
 *
 * Uses the `<=>` cosine distance operator. Returns results ordered
 * by similarity (1 - distance), most similar first. Only rows with
 * a non-NULL embedding are considered.
 *
 * @param table — one of 'sessions', 'spores', 'plans', 'artifacts'
 * @param queryVector — the query embedding as number[]
 * @param options — optional limit and equality filters
 * @returns array of { id, similarity, ...row } ordered by similarity DESC
 */
export async function searchSimilar(
  table: string,
  queryVector: number[],
  options: SearchSimilarOptions = {},
): Promise<SimilarityResult[]> {
  assertValidTable(table);

  const db = getDatabase();
  const vecLiteral = toVectorLiteral(queryVector);
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;

  const conditions: string[] = ['embedding IS NOT NULL'];
  const params: unknown[] = [vecLiteral, limit];
  let paramIndex = 3; // $1 = vector, $2 = limit

  if (options.filters) {
    for (const [column, value] of Object.entries(options.filters)) {
      // Only allow simple alphanumeric column names to prevent injection
      if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
        throw new Error(`Invalid filter column name: ${column}`);
      }
      conditions.push(`${column} = $${paramIndex++}`);
      params.push(value);
    }
  }

  const whereClause = conditions.join(' AND ');

  const columns = TABLE_SELECT_COLUMNS[table as EmbeddableTable];
  const result = await db.query(
    `SELECT ${columns},
            (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) AS similarity
     FROM ${table}
     WHERE ${whereClause}
     ORDER BY embedding <=> $1::vector(${EMBEDDING_DIMENSIONS})
     LIMIT $2`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map((row) => ({
    ...row,
    id: row.id as string,
    similarity: row.similarity as number,
  }));
}

/**
 * Get aggregated embedding queue depth, embedded count, and total across all
 * embeddable tables.
 *
 * For sessions: only counts those with a summary (not bare sessions).
 * For plans/artifacts: only counts those with content (non-NULL).
 *
 * This is the single source of truth for embedding stats — called from both
 * the stats service and the embedding status API handler.
 */
export async function getEmbeddingQueueDepth(): Promise<{
  queue_depth: number;
  embedded_count: number;
  total: number;
}> {
  const db = getDatabase();

  const [queueResult, embeddedResult] = await Promise.all([
    db.query(`
      SELECT
        (SELECT COUNT(*) FROM sessions  WHERE embedding IS NULL AND summary IS NOT NULL) +
        (SELECT COUNT(*) FROM spores    WHERE embedding IS NULL) +
        (SELECT COUNT(*) FROM plans     WHERE embedding IS NULL AND content IS NOT NULL) +
        (SELECT COUNT(*) FROM artifacts WHERE embedding IS NULL AND content IS NOT NULL)
      AS cnt
    `),
    db.query(`
      SELECT
        (SELECT COUNT(*) FROM sessions  WHERE embedding IS NOT NULL) +
        (SELECT COUNT(*) FROM spores    WHERE embedding IS NOT NULL) +
        (SELECT COUNT(*) FROM plans     WHERE embedding IS NOT NULL) +
        (SELECT COUNT(*) FROM artifacts WHERE embedding IS NOT NULL)
      AS cnt
    `),
  ]);

  const queue_depth = Number((queueResult.rows[0] as Record<string, unknown>).cnt ?? 0);
  const embedded_count = Number((embeddedResult.rows[0] as Record<string, unknown>).cnt ?? 0);
  return { queue_depth, embedded_count, total: queue_depth + embedded_count };
}

/**
 * Find rows that do not yet have an embedding, for the embedding worker.
 *
 * Returns rows ordered by created_at ASC so oldest items are processed first.
 *
 * @param table — one of 'sessions', 'spores', 'plans', 'artifacts'
 * @param options — optional limit (default 100)
 * @returns array of { id, created_at }
 */
export async function getUnembedded(
  table: string,
  options: GetUnembeddedOptions = {},
): Promise<UnembeddedRow[]> {
  assertValidTable(table);

  const db = getDatabase();
  const limit = options.limit ?? DEFAULT_UNEMBEDDED_LIMIT;

  const result = await db.query(
    `SELECT id, created_at
     FROM ${table}
     WHERE embedding IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  return (result.rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string | number,
    created_at: row.created_at as number,
  }));
}
