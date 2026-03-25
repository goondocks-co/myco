/**
 * Full-text search using SQLite FTS5.
 *
 * Searches prompt_batches and activities via their FTS5 virtual tables.
 * Semantic search (vector similarity) is handled by the external VectorStore —
 * this module covers text-based retrieval only.
 *
 * All queries use parameterized placeholders throughout.
 */

import { getDatabase } from '@myco/db/client.js';
import {
  SEARCH_RESULTS_DEFAULT_LIMIT,
} from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of characters to include in search result previews. */
const SEARCH_PREVIEW_CHARS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single result returned from full-text search. */
export interface SearchResult {
  id: string;
  type: 'prompt_batch' | 'activity';
  title: string;
  preview: string;
  score: number;
  session_id?: string;
}

/** Options for fullTextSearch. */
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
 * Full-text search across capture tables using SQLite FTS5.
 *
 * Searches prompt_batches (indexed on user_prompt) and activities (indexed
 * on tool_name, tool_input, file_path). The raw query string is passed
 * directly to FTS5 MATCH — callers should sanitize if needed.
 *
 * FTS5 `rank` values are negative (lower = better match). This function
 * converts them to positive scores via `Math.abs()` so higher = better
 * in the returned results.
 *
 * When `options.type` is specified, only the matching table branch is queried.
 *
 * @param query — search string (FTS5 MATCH syntax)
 * @param options — optional type filter and result limit
 * @returns SearchResult[] ordered by score DESC
 */
export function fullTextSearch(
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const db = getDatabase();
  const limit = options.limit ?? SEARCH_RESULTS_DEFAULT_LIMIT;
  const typeFilter = options.type;

  const results: SearchResult[] = [];

  // -- prompt_batches branch ------------------------------------------------
  if (typeFilter === undefined || typeFilter === 'prompt_batch') {
    const batchRows = db.prepare(
      `SELECT pb.id, pb.prompt_number, pb.session_id,
              substr(COALESCE(pb.user_prompt, ''), 1, ?) AS preview,
              fts.rank
       FROM prompt_batches_fts fts
       JOIN prompt_batches pb ON pb.id = fts.rowid
       WHERE prompt_batches_fts MATCH ?
       ORDER BY fts.rank
       LIMIT ?`
    ).all(SEARCH_PREVIEW_CHARS, query, limit) as Array<{
      id: number;
      prompt_number: number | null;
      session_id: string | null;
      preview: string;
      rank: number;
    }>;

    for (const row of batchRows) {
      results.push({
        id: String(row.id),
        type: 'prompt_batch',
        title: row.prompt_number != null
          ? `Batch #${row.prompt_number}`
          : `Batch ${row.id}`,
        preview: row.preview,
        score: Math.abs(row.rank),
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // -- activities branch ----------------------------------------------------
  if (typeFilter === undefined || typeFilter === 'activity') {
    const activityRows = db.prepare(
      `SELECT a.id, a.tool_name, a.tool_input, a.file_path, a.session_id,
              fts.rank
       FROM activities_fts fts
       JOIN activities a ON a.id = fts.rowid
       WHERE activities_fts MATCH ?
       ORDER BY fts.rank
       LIMIT ?`
    ).all(query, limit) as Array<{
      id: number;
      tool_name: string;
      tool_input: string | null;
      file_path: string | null;
      session_id: string | null;
      rank: number;
    }>;

    for (const row of activityRows) {
      const preview = (row.tool_input ?? row.file_path ?? '').slice(0, SEARCH_PREVIEW_CHARS);
      results.push({
        id: String(row.id),
        type: 'activity',
        title: row.tool_name,
        preview,
        score: Math.abs(row.rank),
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // Sort combined results by score DESC and apply limit.
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
