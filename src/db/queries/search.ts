/**
 * Dual-mode search: semantic (pgvector cosine similarity) and full-text (tsvector).
 *
 * - `semanticSearch` — UNION ALL across intelligence layer tables (sessions, spores,
 *   plans, artifacts) which have `embedding vector(1024)` columns.
 * - `fullTextSearch` — ranked tsvector search across raw capture tables
 *   (prompt_batches, activities) which have `search_vector tsvector` columns.
 *
 * All queries use parameterized placeholders throughout.
 */

import { getDatabase } from '@myco/db/client.js';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import { toVectorLiteral } from '@myco/db/queries/embeddings.js';
import {
  SEARCH_RESULTS_DEFAULT_LIMIT,
  SEARCH_SIMILARITY_THRESHOLD,
} from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of characters to include in search result previews. */
const SEARCH_PREVIEW_CHARS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single result returned from either search mode. */
export interface SearchResult {
  id: string;
  type: 'session' | 'spore' | 'plan' | 'artifact' | 'prompt_batch' | 'activity';
  title: string;
  preview: string;
  score: number;
  session_id?: string;
}

/** Options shared by both search functions. */
export interface SearchOptions {
  /** Restrict results to a single type. */
  type?: string;
  /** Maximum number of results to return (default: SEARCH_RESULTS_DEFAULT_LIMIT). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Semantic search across intelligence layer tables using pgvector cosine similarity.
 *
 * Searches sessions, spores, plans, and artifacts — all tables that have an
 * `embedding vector(1024)` column. Results are ordered by similarity score
 * (highest first) and filtered to scores above SEARCH_SIMILARITY_THRESHOLD.
 *
 * When `options.type` is specified, only the matching table branch is queried
 * (no client-side filtering needed).
 *
 * The query vector is passed as a parameterized value — never interpolated.
 *
 * @param queryVector — 1024-dimension embedding for the query
 * @param options — optional type filter and result limit
 * @returns SearchResult[] ordered by score DESC
 */
export async function semanticSearch(
  queryVector: number[],
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const db = getDatabase();
  const limit = options.limit ?? SEARCH_RESULTS_DEFAULT_LIMIT;
  const vectorStr = toVectorLiteral(queryVector);

  // Build only the UNION ALL branches that match the type filter.
  const branches: string[] = [];
  const typeFilter = options.type;

  if (typeFilter === undefined || typeFilter === 'session') {
    branches.push(`
    SELECT
      id::text,
      'session'::text AS type,
      COALESCE(title, id) AS title,
      LEFT(COALESCE(summary, ''), ${SEARCH_PREVIEW_CHARS}) AS preview,
      (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) AS score,
      NULL::text AS session_id
    FROM sessions
    WHERE embedding IS NOT NULL
      AND (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) > $2`);
  }

  if (typeFilter === undefined || typeFilter === 'spore') {
    branches.push(`
    SELECT
      id::text,
      'spore'::text AS type,
      COALESCE(observation_type, id) AS title,
      LEFT(COALESCE(content, ''), ${SEARCH_PREVIEW_CHARS}) AS preview,
      (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) AS score,
      session_id::text AS session_id
    FROM spores
    WHERE embedding IS NOT NULL
      AND (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) > $2`);
  }

  if (typeFilter === undefined || typeFilter === 'plan') {
    branches.push(`
    SELECT
      id::text,
      'plan'::text AS type,
      COALESCE(title, id) AS title,
      LEFT(COALESCE(content, ''), ${SEARCH_PREVIEW_CHARS}) AS preview,
      (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) AS score,
      NULL::text AS session_id
    FROM plans
    WHERE embedding IS NOT NULL
      AND (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) > $2`);
  }

  if (typeFilter === undefined || typeFilter === 'artifact') {
    branches.push(`
    SELECT
      id::text,
      'artifact'::text AS type,
      title AS title,
      LEFT(COALESCE(content, ''), ${SEARCH_PREVIEW_CHARS}) AS preview,
      (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) AS score,
      NULL::text AS session_id
    FROM artifacts
    WHERE embedding IS NOT NULL
      AND (1 - (embedding <=> $1::vector(${EMBEDDING_DIMENSIONS}))) > $2`);
  }

  // If the type doesn't match any semantic table, return empty results.
  if (branches.length === 0) return [];

  const unionQuery = branches.join('\n    UNION ALL\n') + `
    ORDER BY score DESC
    LIMIT $3
  `;

  const result = await db.query(unionQuery, [vectorStr, SEARCH_SIMILARITY_THRESHOLD, limit]);

  const rows = result.rows as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    type: row.type as SearchResult['type'],
    title: row.title as string,
    preview: row.preview as string,
    score: row.score as number,
    ...(row.session_id != null ? { session_id: row.session_id as string } : {}),
  }));
}

/**
 * Full-text search across raw capture tables using Postgres tsvector.
 *
 * Searches prompt_batches (indexed on user_prompt) and activities (indexed
 * on tool_name, tool_input, file_path). Uses `plainto_tsquery` for safe
 * input handling — no special tsquery syntax required from callers.
 *
 * When `options.type` is specified, only the matching table branch is queried
 * (no client-side filtering needed).
 *
 * The query string is always passed as a parameterized value.
 *
 * @param query — plain-language search string
 * @param options — optional type filter and result limit
 * @returns SearchResult[] ordered by score DESC
 */
export async function fullTextSearch(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const db = getDatabase();
  const limit = options.limit ?? SEARCH_RESULTS_DEFAULT_LIMIT;

  // Build only the UNION ALL branches that match the type filter.
  const branches: string[] = [];
  const typeFilter = options.type;

  if (typeFilter === undefined || typeFilter === 'prompt_batch') {
    branches.push(`
    SELECT
      id::text,
      'prompt_batch'::text AS type,
      COALESCE('Batch #' || prompt_number::text, 'Batch ' || id::text) AS title,
      LEFT(COALESCE(user_prompt, ''), ${SEARCH_PREVIEW_CHARS}) AS preview,
      ts_rank(search_vector, plainto_tsquery('english', $1)) AS score,
      session_id::text AS session_id
    FROM prompt_batches
    WHERE search_vector @@ plainto_tsquery('english', $1)`);
  }

  if (typeFilter === undefined || typeFilter === 'activity') {
    branches.push(`
    SELECT
      id::text,
      'activity'::text AS type,
      tool_name AS title,
      LEFT(COALESCE(tool_input, file_path, ''), ${SEARCH_PREVIEW_CHARS}) AS preview,
      ts_rank(search_vector, plainto_tsquery('english', $1)) AS score,
      session_id::text AS session_id
    FROM activities
    WHERE search_vector @@ plainto_tsquery('english', $1)`);
  }

  // If the type doesn't match any FTS table, return empty results.
  if (branches.length === 0) return [];

  const unionQuery = branches.join('\n    UNION ALL\n') + `
    ORDER BY score DESC
    LIMIT $2
  `;

  const result = await db.query(unionQuery, [query, limit]);

  const rows = result.rows as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    type: row.type as SearchResult['type'],
    title: row.title as string,
    preview: row.preview as string,
    score: row.score as number,
    ...(row.session_id != null ? { session_id: row.session_id as string } : {}),
  }));
}
