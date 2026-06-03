import type { AgentVectorSearchResult } from '@myco/agent/runtime/ports.js';

export interface SemanticShortlistProvider {
  embedQuery(text: string): Promise<number[] | null>;
  searchVectors(query: number[], options?: {
    namespace?: string;
    limit?: number;
    threshold?: number;
    filters?: Record<string, unknown>;
  }): AgentVectorSearchResult[];
}

export interface SemanticShortlistOptions {
  provider?: SemanticShortlistProvider;
  namespace: string;
  query: string;
  candidateIds?: Set<string>;
  maxResults: number;
  overFetch: number;
  threshold: number;
  filters?: Record<string, unknown>;
}

export async function shortlistSemanticIds(
  options: SemanticShortlistOptions,
): Promise<string[]> {
  const {
    provider,
    namespace,
    query,
    candidateIds,
    maxResults,
    overFetch,
    threshold,
    filters,
  } = options;
  if (!provider || maxResults <= 0) return [];

  const queryVector = await provider.embedQuery(query);
  if (!queryVector) return [];

  const results = provider.searchVectors(queryVector, {
    namespace,
    limit: Math.max(maxResults, maxResults * overFetch),
    threshold,
    filters,
  });

  const shortlisted = candidateIds
    ? results.filter(result => candidateIds.has(result.id))
    : results;

  shortlisted.sort((a, b) => b.similarity - a.similarity);
  return shortlisted.slice(0, maxResults).map(result => result.id);
}
