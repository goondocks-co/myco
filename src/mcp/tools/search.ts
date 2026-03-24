/**
 * myco_search — semantic search across the vault.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 * The daemon handles embedding and similarity search internally.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { MCP_SEARCH_DEFAULT_LIMIT } from '@myco/constants.js';
import { buildEndpoint } from './shared.js';

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
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSearch(
  input: SearchInput,
  client: DaemonClient,
): Promise<SearchResult[]> {
  const limit = input.limit ?? MCP_SEARCH_DEFAULT_LIMIT;

  const endpoint = buildEndpoint('/api/search', {
    q: input.query,
    limit,
    type: input.type,
  });
  const result = await client.get(endpoint);
  if (!result.ok || !result.data?.results) return [];

  return result.data.results as SearchResult[];
}
