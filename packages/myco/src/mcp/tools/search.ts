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
  observation_type?: string;
  status?: string;
  since?: number;
  until?: number;
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

function requiresSemanticMode(input: SearchInput): boolean {
  return input.observation_type !== undefined
    || input.status !== undefined
    || input.since !== undefined
    || input.until !== undefined;
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
    mode: requiresSemanticMode(input) ? 'semantic' : undefined,
    type: input.type,
    observation_type: input.observation_type,
    status: input.status,
    since: input.since,
    until: input.until,
  });
  const result = await client.get(endpoint);
  if (!result.ok || !result.data?.results) return [];

  return result.data.results as SearchResult[];
}
