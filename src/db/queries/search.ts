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
  SEARCH_PREVIEW_CHARS,
} from '@myco/constants.js';
import type { VectorSearchResult } from '@myco/daemon/embedding/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All result types that can appear in search results. */
export type SearchResultType =
  | 'session'
  | 'spore'
  | 'plan'
  | 'artifact'
  | 'prompt_batch'
  | 'activity';

/** A single result returned from full-text or semantic search. */
export interface SearchResult {
  id: string;
  type: SearchResultType;
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

// ---------------------------------------------------------------------------
// Hydration — convert VectorSearchResults into SearchResults
// ---------------------------------------------------------------------------

/** Row shape returned from sessions table for hydration. */
interface SessionRow {
  id: string;
  title: string | null;
  summary: string | null;
  session_id?: undefined;
}

/** Row shape returned from spores table for hydration. */
interface SporeRow {
  id: string;
  observation_type: string;
  content: string;
  session_id: string | null;
}

/** Row shape returned from plans table for hydration. */
interface PlanRow {
  id: string;
  title: string | null;
  content: string | null;
}

/** Row shape returned from artifacts table for hydration. */
interface ArtifactRow {
  id: string;
  title: string;
  content: string | null;
}

/**
 * Hydrate vector search results into SearchResults by fetching full records
 * from the record store.
 *
 * Groups results by namespace, queries each table for the relevant IDs, then
 * maps them into SearchResult format with titles and previews.
 */
export function hydrateSearchResults(
  vectorResults: VectorSearchResult[],
): SearchResult[] {
  if (vectorResults.length === 0) return [];

  const db = getDatabase();
  const results: SearchResult[] = [];

  // Group result IDs by namespace
  const byNamespace = new Map<string, VectorSearchResult[]>();
  for (const vr of vectorResults) {
    const group = byNamespace.get(vr.namespace) ?? [];
    group.push(vr);
    byNamespace.set(vr.namespace, group);
  }

  // Use json_each so the statement text is stable and SQLite can cache the plan.
  const sessionStmt = db.prepare(
    `SELECT id, title, summary FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
  );
  const sporeStmt = db.prepare(
    `SELECT id, observation_type, content, session_id FROM spores WHERE id IN (SELECT value FROM json_each(?))`,
  );
  const planStmt = db.prepare(
    `SELECT id, title, content FROM plans WHERE id IN (SELECT value FROM json_each(?))`,
  );
  const artifactStmt = db.prepare(
    `SELECT id, title, content FROM artifacts WHERE id IN (SELECT value FROM json_each(?))`,
  );

  // --- sessions ---
  const sessionResults = byNamespace.get('sessions');
  if (sessionResults && sessionResults.length > 0) {
    const ids = sessionResults.map((r) => r.id);
    const rows = sessionStmt.all(JSON.stringify(ids)) as SessionRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const vr of sessionResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        id: row.id,
        type: 'session',
        title: row.title ?? `Session ${row.id.slice(-6)}`,
        preview: (row.summary ?? '').slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
      });
    }
  }

  // --- spores ---
  const sporeResults = byNamespace.get('spores');
  if (sporeResults && sporeResults.length > 0) {
    const ids = sporeResults.map((r) => r.id);
    const rows = sporeStmt.all(JSON.stringify(ids)) as SporeRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const vr of sporeResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        id: row.id,
        type: 'spore',
        title: row.observation_type,
        preview: row.content.slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // --- plans ---
  const planResults = byNamespace.get('plans');
  if (planResults && planResults.length > 0) {
    const ids = planResults.map((r) => r.id);
    const rows = planStmt.all(JSON.stringify(ids)) as PlanRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const vr of planResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        id: row.id,
        type: 'plan',
        title: row.title ?? `Plan ${row.id.slice(-6)}`,
        preview: (row.content ?? '').slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
      });
    }
  }

  // --- artifacts ---
  const artifactResults = byNamespace.get('artifacts');
  if (artifactResults && artifactResults.length > 0) {
    const ids = artifactResults.map((r) => r.id);
    const rows = artifactStmt.all(JSON.stringify(ids)) as ArtifactRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const vr of artifactResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        id: row.id,
        type: 'artifact',
        title: row.title,
        preview: (row.content ?? '').slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
      });
    }
  }

  // Preserve the original similarity-based ordering from vector search
  results.sort((a, b) => b.score - a.score);
  return results;
}
