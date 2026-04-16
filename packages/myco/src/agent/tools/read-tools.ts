/**
 * Read-only vault tools.
 *
 * 9 tools: vault_unprocessed, vault_batches, vault_spores, vault_sessions,
 * vault_search_fts, vault_search_semantic, vault_state, vault_entities,
 * vault_edges
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { SEARCH_SIMILARITY_THRESHOLD, TEAM_SOURCE_PREFIX } from '@myco/constants.js';
import { getUnprocessedBatches, listBatchesBySession } from '@myco/db/queries/batches.js';
import { getSpore, listSpores } from '@myco/db/queries/spores.js';
import { listSessions, getActiveSessionIds } from '@myco/db/queries/sessions.js';
import { getStatesForAgent } from '@myco/db/queries/agent-state.js';
import { fullTextSearch, hydrateSearchResults } from '@myco/db/queries/search.js';
import { listEntities } from '@myco/db/queries/entities.js';
import { listGraphEdges } from '@myco/db/queries/graph-edges.js';
import { textResult, type VaultToolDeps } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default limit for unprocessed batches query. */
const DEFAULT_UNPROCESSED_LIMIT = 50;

/** Default limit for spore listing. */
const DEFAULT_SPORES_LIMIT = 50;

/** Default limit for session listing. */
const DEFAULT_SESSIONS_LIMIT = 20;

/** Default limit for similarity search results. */
const DEFAULT_SEARCH_LIMIT = 10;

/** Default limit for entity listing. */
const DEFAULT_ENTITIES_LIMIT = 50;

/** Default limit for edge listing. */
const DEFAULT_EDGES_LIMIT = 50;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReadTools(deps: VaultToolDeps) {
  const { agentId, embeddingManager, teamClient, machineId } = deps;

  const vaultUnprocessed = tool(
    'vault_unprocessed',
    'Get unprocessed prompt batches, ordered by id ASC. Supports cursor-based pagination. Batches from in-flight sessions are excluded by default so intelligence tasks only process settled work; pass include_active=true only if you specifically need live data (e.g., title-summary).',
    {
      after_id: z.number().optional().describe('Return batches with id greater than this'),
      limit: z.number().optional().describe('Maximum number of batches to return'),
      include_active: z.boolean().optional().describe('Include batches from sessions still in active status (default: false)'),
    },
    async (args) => {
      const batches = getUnprocessedBatches({
        after_id: args.after_id,
        limit: args.limit ?? DEFAULT_UNPROCESSED_LIMIT,
        includeActive: args.include_active === true,
      });
      return textResult(batches);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultBatches = tool(
    'vault_batches',
    'List prompt batches for one session, ordered by prompt_number ASC. Use this when you already know the session ID and need the full session arc rather than only unprocessed batches.',
    {
      session_id: z.string().describe('Session ID whose batches should be returned'),
      limit: z.number().optional().describe('Maximum number of batches to return'),
      offset: z.number().optional().describe('Number of batches to skip from the start'),
    },
    async (args) => {
      const batches = listBatchesBySession(args.session_id, {
        limit: args.limit,
        offset: args.offset,
      });
      return textResult(batches);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSpores = tool(
    'vault_spores',
    'List spores with optional filters (agent, observation type, status, session), or fetch exact spores by id for full-content inspection after a semantic shortlist. Spores from in-flight sessions are excluded by default; passing a specific session_id or ids bypasses this filter. Pass include_active=true to bulk-read live work.',
    {
      ids: z.array(z.string()).optional().describe('Fetch exact spores by id in the given order; bypasses active-session gating'),
      agent_id: z.string().optional().describe('Filter by agent ID'),
      observation_type: z.string().optional().describe('Filter by observation type (e.g., gotcha, decision)'),
      status: z.enum(['active', 'superseded', 'archived']).optional().describe('Filter by status'),
      session_id: z.string().optional().describe('Filter by session ID (bypasses active-session gating)'),
      limit: z.number().optional().describe('Maximum number of spores to return'),
      include_active: z.boolean().optional().describe('Include spores from sessions still in active status (default: false)'),
    },
    async (args) => {
      if (args.ids && args.ids.length > 0) {
        const spores = args.ids
          .map((id) => getSpore(id))
          .filter((spore): spore is NonNullable<typeof spore> => spore !== null);
        return textResult(spores);
      }
      const spores = listSpores({
        agent_id: args.agent_id,
        observation_type: args.observation_type,
        status: args.status,
        session_id: args.session_id,
        limit: args.limit ?? DEFAULT_SPORES_LIMIT,
        includeActive: args.include_active === true,
      });
      return textResult(spores);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSessions = tool(
    'vault_sessions',
    'List sessions with optional status filter, or fetch one exact session by id. In-flight sessions are excluded by default; pass include_active=true or an explicit status to see them.',
    {
      id: z.string().optional().describe('Exact session ID to fetch'),
      limit: z.number().optional().describe('Maximum number of sessions to return'),
      status: z.string().optional().describe('Filter by status (active, completed)'),
      include_active: z.boolean().optional().describe('Include sessions still in active status (default: false)'),
    },
    async (args) => {
      const sessions = listSessions({
        id: args.id,
        limit: args.limit ?? DEFAULT_SESSIONS_LIMIT,
        status: args.status,
        includeActive: args.include_active === true,
      });
      return textResult(sessions);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSearchFts = tool(
    'vault_search_fts',
    'Full-text search across sessions, spores, prompt batches, and activities using FTS5. Best for finding exact keywords, file paths, function names, and specific text. Results from in-flight sessions are hidden by default so intelligence tasks only see settled work; pass include_active=true to bypass.',
    {
      query: z.string().describe('Search query text'),
      type: z.string().optional().describe('Restrict to a result type (session, spore, prompt_batch, activity)'),
      limit: z.number().optional().describe('Maximum number of results to return'),
      include_active: z.boolean().optional().describe('Include results from sessions still in active status (default: false)'),
    },
    async (args) => {
      try {
        const results = fullTextSearch(args.query, {
          type: args.type,
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
          includeActive: args.include_active === true,
        });
        return textResult({ results });
      } catch {
        return textResult({ results: [], message: 'Search unavailable' });
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSearchSemantic = tool(
    'vault_search_semantic',
    'Semantic similarity search across embedded vault content (spores, sessions, plans, artifacts, skill_records). Best for finding conceptually related content. Returns results ranked by similarity score. Results from in-flight sessions are filtered out by default; pass include_active=true to bypass.',
    {
      query: z.string().describe('Search query text'),
      namespace: z.string().optional().describe('Restrict to a content type: spores, sessions, plans, artifacts, skill_records. Omit to search all.'),
      limit: z.number().optional().describe('Maximum results to return'),
      include_active: z.boolean().optional().describe('Include results from sessions still in active status (default: false)'),
    },
    async (args) => {
      if (!embeddingManager) {
        return textResult({ results: [], message: 'Embedding provider unavailable' });
      }
      try {
        const queryVector = await embeddingManager.embedQuery(args.query);
        if (!queryVector) {
          return textResult({ results: [], message: 'Embedding provider unavailable' });
        }
        const searchLimit = args.limit ?? DEFAULT_SEARCH_LIMIT;
        const excludeActive = args.include_active !== true;
        const activeIds = excludeActive ? getActiveSessionIds() : new Set<string>();

        // Fire local and team search in parallel
        const [rawLocalResults, teamResults] = await Promise.all([
          Promise.resolve(
            embeddingManager.searchVectors(queryVector, {
              namespace: args.namespace,
              limit: searchLimit,
              threshold: SEARCH_SIMILARITY_THRESHOLD,
            }).map((r) => ({ ...r, source: 'local' as const })),
          ),
          teamClient
            ? teamClient.search(args.query, { limit: searchLimit })
                .then((res) => res.results.map((r) => ({ ...r, source: `${TEAM_SOURCE_PREFIX}${r.machine_id}` })))
                .catch(() => [] as Array<Record<string, unknown>>)
            : Promise.resolve([] as Array<Record<string, unknown>>),
        ]);

        const localResults = activeIds.size > 0
          ? rawLocalResults.filter((r) => {
              const sid = r.metadata?.session_id;
              return typeof sid !== 'string' || !activeIds.has(sid);
            })
          : rawLocalResults;

        const hydratedLocalResults = hydrateSearchResults(localResults).map((r) => ({
          ...r,
          source: 'local' as const,
        }));

        // Deduplicate: skip team results from this machine (we already have them locally)
        let dedupedTeam = machineId
          ? teamResults.filter((r) => (r as Record<string, unknown>).machine_id !== machineId)
          : teamResults;

        if (activeIds.size > 0) {
          dedupedTeam = dedupedTeam.filter((r) => {
            const sid = (r as { metadata?: { session_id?: unknown } }).metadata?.session_id;
            return typeof sid !== 'string' || !activeIds.has(sid);
          });
        }

        const merged = [
          ...hydratedLocalResults,
          ...dedupedTeam,
        ]
          .sort((a, b) => ((b.score as number) ?? 0) - ((a.score as number) ?? 0))
          .slice(0, searchLimit);

        return textResult({ results: merged });
      } catch {
        return textResult({ results: [], message: 'Semantic search unavailable' });
      }
    },
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const vaultState = tool(
    'vault_state',
    'Get all state key-value pairs for the current agent.',
    {},
    async () => {
      const states = getStatesForAgent(agentId);
      return textResult(states);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultEntities = tool(
    'vault_entities',
    'List knowledge graph entities with optional filters.',
    {
      type: z.enum(['component', 'concept', 'person']).optional().describe('Filter by entity type'),
      name: z.string().optional().describe('Filter by entity name (exact match)'),
      limit: z.number().optional().describe('Maximum entities to return'),
    },
    async (args) => {
      const entities = listEntities({
        agent_id: agentId,
        type: args.type,
        name: args.name,
        limit: args.limit ?? DEFAULT_ENTITIES_LIMIT,
      });
      return textResult(entities);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultEdges = tool(
    'vault_edges',
    'List knowledge graph edges with optional filters. Use to check existing relationships before creating new ones.',
    {
      source_id: z.string().optional().describe('Filter by source node ID'),
      target_id: z.string().optional().describe('Filter by target node ID'),
      type: z.string().optional().describe('Filter by edge type (REFERENCES, DEPENDS_ON, AFFECTS, etc.)'),
      limit: z.number().optional().describe('Maximum edges to return'),
    },
    async (args) => {
      const edges = listGraphEdges({
        sourceId: args.source_id,
        targetId: args.target_id,
        type: args.type,
        agentId: agentId,
        limit: args.limit ?? DEFAULT_EDGES_LIMIT,
      });
      return textResult(edges);
    },
    { annotations: { readOnlyHint: true } },
  );

  return [
    vaultUnprocessed,
    vaultBatches,
    vaultSpores,
    vaultSessions,
    vaultSearchFts,
    vaultSearchSemantic,
    vaultState,
    vaultEntities,
    vaultEdges,
  ];
}
