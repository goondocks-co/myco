/**
 * myco_search — semantic search across the vault.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 * The daemon handles embedding and similarity search internally.
 */

import { MCP_SEARCH_DEFAULT_LIMIT } from '@myco/constants.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { normalizeSearchResults, type NormalizedSearchResult } from '@myco/search-results.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';
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
  /** Canopy-only: optional language filter (e.g. "typescript"). */
  language?: string;
}

function requiresSemanticMode(input: SearchInput): boolean {
  // Canopy is its own retrieval surface — always semantic, never FTS-fallback.
  if (input.type === 'canopy') return true;
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
  requestContext?: MycoRequestContext,
): Promise<NormalizedSearchResult[]> {
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
    language: input.language,
  });
  const result = requestContext
    ? await client.get(endpoint, { headers: requestContextHeaders(requestContext) })
    : await client.get(endpoint);
  if (!result.ok || !result.data?.results) return [];

  return normalizeSearchResults(result.data.results);
}
