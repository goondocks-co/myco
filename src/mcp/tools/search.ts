/**
 * myco_search — semantic search across the vault.
 *
 * Uses pgvector similarity search via `searchSimilar()`. The query text is
 * embedded using the configured embedding provider. If no embedding provider
 * is available (Phase 1 without local models), returns empty results gracefully.
 */

import { searchSimilar, type SimilarityResult } from '@myco/db/queries/embeddings.js';
import { tryEmbed } from '@myco/intelligence/embed-query.js';
import { MCP_SEARCH_DEFAULT_LIMIT, CONTENT_SNIPPET_CHARS } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchInput {
  query: string;
  type?: string;
  limit?: number;
}

interface SearchResult {
  id: string;
  type: string;
  content: string;
  score: number;
  observation_type?: string;
  status?: string;
  tags?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSearchResult(row: SimilarityResult, table: string): SearchResult {
  const base: SearchResult = {
    id: row.id,
    type: table,
    content: ((row.content as string) ?? (row.summary as string) ?? '').slice(0, CONTENT_SNIPPET_CHARS),
    score: row.similarity,
  };

  if (table === 'spores') {
    base.observation_type = row.observation_type as string;
    base.status = row.status as string;
    base.tags = row.tags as string;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSearch(
  input: SearchInput,
): Promise<SearchResult[]> {
  const limit = input.limit ?? MCP_SEARCH_DEFAULT_LIMIT;

  const queryVector = await tryEmbed(input.query);
  if (!queryVector) {
    // No embedding provider available — return empty results gracefully
    return [];
  }

  // Determine which tables to search based on type filter
  const tablesToSearch = resolveSearchTables(input.type);

  // Search all tables in parallel
  const searchPromises = tablesToSearch.map((table) => {
    const filters: Record<string, unknown> = {};
    if (table === 'spores') {
      filters.status = 'active';
    }

    return searchSimilar(table, queryVector, {
      limit,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
    }).then((results) =>
      results.map((row) => toSearchResult(row, table)),
    );
  });

  const resultSets = await Promise.all(searchPromises);
  const allResults: SearchResult[] = resultSets.flat();

  // Sort by score descending, limit to requested count
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}

/** Map the user-facing type filter to embeddable table names. */
function resolveSearchTables(type?: string): string[] {
  switch (type) {
    case 'session':
      return ['sessions'];
    case 'spore':
      return ['spores'];
    default:
      // 'all' or undefined — search all embeddable tables
      return ['spores', 'sessions'];
  }
}
