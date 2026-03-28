/**
 * Vault MCP tool server for the agent.
 *
 * Creates 18 tools that expose SQLite query helpers to the agent
 * via the Claude Agent SDK. Tools are grouped into:
 * - Read tools: vault_unprocessed, vault_spores, vault_sessions, vault_search_fts,
 *               vault_search_semantic, vault_state, vault_entities, vault_edges,
 *               vault_read_digest
 * - Write tools: vault_create_spore, vault_create_entity, vault_create_edge,
 *                vault_resolve_spore, vault_update_session, vault_set_state,
 *                vault_write_digest, vault_mark_processed
 * - Observability: vault_report
 *
 * `agentId` and `runId` are captured in closures — tools inject them
 * automatically so the agent cannot impersonate another agent.
 */

import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds, SEARCH_SIMILARITY_THRESHOLD } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { getUnprocessedBatches, markBatchProcessed } from '@myco/db/queries/batches.js';
import { listSpores, insertSpore, updateSporeStatus, DEFAULT_IMPORTANCE } from '@myco/db/queries/spores.js';
import { listSessions, updateSession } from '@myco/db/queries/sessions.js';
import { getStatesForAgent, setState } from '@myco/db/queries/agent-state.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { EMBEDDABLE_TABLES, type EmbeddableTable } from '@myco/db/queries/embeddings.js';
import { fullTextSearch } from '@myco/db/queries/search.js';
import { insertEntity, listEntities } from '@myco/db/queries/entities.js';
import { insertGraphEdge, listGraphEdges } from '@myco/db/queries/graph-edges.js';
import { createSporeLineage } from '@myco/db/queries/lineage.js';
import { insertResolutionEvent } from '@myco/db/queries/resolution-events.js';
import { upsertDigestExtract, listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/index.js';

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

/** Default embeddable table for search. */
const DEFAULT_SEARCH_TABLE: EmbeddableTable = 'spores';

/** Default limit for entity listing. */
const DEFAULT_ENTITIES_LIMIT = 50;

/** Default limit for edge listing. */
const DEFAULT_EDGES_LIMIT = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a value as a JSON text content block for tool output. */
function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

// ---------------------------------------------------------------------------
// Tool definitions factory
// ---------------------------------------------------------------------------

/** Total number of vault tools defined. */
export const VAULT_TOOL_COUNT = 18;

/**
 * Create the 18 vault tool definitions for the agent.
 *
 * Exposed for testing (call handler directly) and for the MCP server factory.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @returns array of SdkMcpToolDefinition objects.
 */
export function createVaultTools(agentId: string, runId: string, turnOffset = 0, embeddingManager?: EmbeddingManager) {
  /** Turn number counter — incremented per tool call (read and write) within a run. */
  let turnCounter = turnOffset;

  /**
   * Record a turn in the audit trail.
   * Called for ALL tool invocations (read and write) for full visibility.
   * Fire-and-forget — does not block the tool response.
   */
  function recordTurn(toolName: string, toolInput: unknown): void {
    turnCounter++;
    try {
      insertTurn({
        run_id: runId,
        agent_id: agentId,
        turn_number: turnCounter,
        tool_name: toolName,
        tool_input: JSON.stringify(toolInput),
        started_at: epochSeconds(),
      });
    } catch {
      /* audit trail is best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------

  const vaultUnprocessed = tool(
    'vault_unprocessed',
    'Get unprocessed prompt batches, ordered by id ASC. Supports cursor-based pagination.',
    {
      after_id: z.number().optional().describe('Return batches with id greater than this'),
      limit: z.number().optional().describe('Maximum number of batches to return'),
    },
    async (args) => {
      recordTurn('vault_unprocessed', args);
      const batches = getUnprocessedBatches({
        after_id: args.after_id,
        limit: args.limit ?? DEFAULT_UNPROCESSED_LIMIT,
      });
      return textResult(batches);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSpores = tool(
    'vault_spores',
    'List spores with optional filters (agent, observation type, status, session).',
    {
      agent_id: z.string().optional().describe('Filter by agent ID'),
      observation_type: z.string().optional().describe('Filter by observation type (e.g., gotcha, decision)'),
      status: z.enum(['active', 'superseded', 'archived']).optional().describe('Filter by status'),
      session_id: z.string().optional().describe('Filter by session ID'),
      limit: z.number().optional().describe('Maximum number of spores to return'),
    },
    async (args) => {
      recordTurn('vault_spores', args);
      const spores = listSpores({
        agent_id: args.agent_id,
        observation_type: args.observation_type,
        status: args.status,
        session_id: args.session_id,
        limit: args.limit ?? DEFAULT_SPORES_LIMIT,
      });
      return textResult(spores);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSessions = tool(
    'vault_sessions',
    'List sessions with optional status filter, ordered by created_at DESC.',
    {
      limit: z.number().optional().describe('Maximum number of sessions to return'),
      status: z.string().optional().describe('Filter by status (active, completed)'),
    },
    async (args) => {
      recordTurn('vault_sessions', args);
      const sessions = listSessions({
        limit: args.limit ?? DEFAULT_SESSIONS_LIMIT,
        status: args.status,
      });
      return textResult(sessions);
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultSearchFts = tool(
    'vault_search_fts',
    'Full-text search across prompt batches and activities using FTS5. Best for finding specific text, keywords, or session content. Does NOT search spores or entities.',
    {
      query: z.string().describe('Search query text'),
      type: z.string().optional().describe('Restrict to a result type (prompt_batch, activity)'),
      limit: z.number().optional().describe('Maximum number of results to return'),
    },
    async (args) => {
      recordTurn('vault_search_fts', args);
      try {
        const results = fullTextSearch(args.query, {
          type: args.type,
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
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
    'Semantic similarity search across embedded vault content (spores, sessions). Best for finding conceptually related content. Returns results ranked by similarity score.',
    {
      query: z.string().describe('Search query text'),
      namespace: z.string().optional().describe('Restrict to a content type: spores, sessions'),
      limit: z.number().optional().describe('Maximum results to return'),
    },
    async (args) => {
      recordTurn('vault_search_semantic', args);
      if (!embeddingManager) {
        return textResult({ results: [], message: 'Embedding provider unavailable' });
      }
      try {
        const queryVector = await embeddingManager.embedQuery(args.query);
        if (!queryVector) {
          return textResult({ results: [], message: 'Embedding provider unavailable' });
        }
        const results = embeddingManager.searchVectors(queryVector, {
          namespace: args.namespace,
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
          threshold: SEARCH_SIMILARITY_THRESHOLD,
        });
        return textResult({ results });
      } catch {
        return textResult({ results: [], message: 'Semantic search unavailable' });
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultState = tool(
    'vault_state',
    'Get all state key-value pairs for the current agent.',
    {},
    async () => {
      recordTurn('vault_state', {});
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
      recordTurn('vault_entities', args);
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
      recordTurn('vault_edges', args);
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

  // -------------------------------------------------------------------------
  // Write tools
  // -------------------------------------------------------------------------

  const vaultCreateSpore = tool(
    'vault_create_spore',
    'Create a new spore (observation) in the vault. The agent_id is set automatically.',
    {
      observation_type: z.string().describe('Type of observation (gotcha, decision, discovery, trade-off, bug_fix, etc.)'),
      content: z.string().describe('The observation content in markdown'),
      session_id: z.string().optional().describe('Associated session ID'),
      prompt_batch_id: z.number().optional().describe('Associated prompt batch ID'),
      importance: z.number().optional().describe('Importance score 1-10 (default 5)'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      context: z.string().optional().describe('Additional context about the observation'),
      file_path: z.string().optional().describe('Related file path'),
      properties: z.string().optional().describe('JSON metadata (e.g., {"consolidated_from": [...]} for wisdom spores)'),
    },
    async (args) => {
      const id = crypto.randomUUID();
      const now = epochSeconds();

      const spore = insertSpore({
        id,
        agent_id: agentId,
        observation_type: args.observation_type,
        content: args.content,
        session_id: args.session_id ?? null,
        prompt_batch_id: args.prompt_batch_id ?? null,
        importance: args.importance ?? DEFAULT_IMPORTANCE,
        tags: args.tags ? JSON.stringify(args.tags) : null,
        context: args.context ?? null,
        file_path: args.file_path ?? null,
        properties: args.properties ?? null,
        created_at: now,
      });

      // Best-effort: structural lineage edges (FROM_SESSION, EXTRACTED_FROM, DERIVED_FROM)
      try { createSporeLineage(spore); } catch { /* lineage best-effort */ }

      embeddingManager?.onContentWritten('spores', spore.id, args.content, {
        status: 'active',
        observation_type: args.observation_type,
        session_id: args.session_id,
      }).catch(() => {});

      recordTurn('vault_create_spore', args);
      return textResult(spore);
    },
  );

  const vaultCreateEntity = tool(
    'vault_create_entity',
    'Create or update an entity in the knowledge graph. Uses UPSERT on (agent_id, type, name).',
    {
      type: z.enum(['component', 'concept', 'person']).describe('Entity type'),
      name: z.string().describe('Entity name (unique within agent + type)'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Additional properties as key-value pairs'),
    },
    async (args) => {
      const id = crypto.randomUUID();
      const now = epochSeconds();
      const props = args.properties ? JSON.stringify(args.properties) : null;

      const entity = insertEntity({
        id,
        agent_id: agentId,
        type: args.type,
        name: args.name,
        properties: props,
        first_seen: now,
        last_seen: now,
      });

      recordTurn('vault_create_entity', args);
      return textResult(entity);
    },
  );

  const vaultCreateEdge = tool(
    'vault_create_edge',
    'Create a semantic edge in the knowledge graph. Lineage edges (FROM_SESSION, EXTRACTED_FROM, HAS_BATCH, DERIVED_FROM) are created automatically — do NOT create those.',
    {
      source_id: z.string().describe('Source node ID'),
      source_type: z.enum(['session', 'batch', 'spore', 'entity']).describe('Source node type'),
      target_id: z.string().describe('Target node ID'),
      target_type: z.enum(['session', 'batch', 'spore', 'entity']).describe('Target node type'),
      type: z.enum(['RELATES_TO', 'SUPERSEDED_BY', 'REFERENCES', 'DEPENDS_ON', 'AFFECTS']).describe('Semantic edge type'),
      session_id: z.string().optional().describe('Session where this relationship was observed'),
      confidence: z.number().optional().describe('Confidence score 0-1 (default 1.0)'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Additional properties as key-value pairs'),
    },
    async (args) => {
      const now = epochSeconds();
      const props = args.properties ? JSON.stringify(args.properties) : undefined;

      const edge = insertGraphEdge({
        agent_id: agentId,
        source_id: args.source_id,
        source_type: args.source_type,
        target_id: args.target_id,
        target_type: args.target_type,
        type: args.type,
        session_id: args.session_id,
        confidence: args.confidence,
        properties: props,
        created_at: now,
      });

      recordTurn('vault_create_edge', args);
      return textResult(edge);
    },
  );

  const vaultResolveSpore = tool(
    'vault_resolve_spore',
    'Resolve a spore by updating its status and recording a resolution event.',
    {
      spore_id: z.string().describe('ID of the spore to resolve'),
      action: z.enum(['supersede', 'archive', 'merge', 'split', 'consolidate']).describe('Resolution action'),
      new_spore_id: z.string().optional().describe('ID of the replacement spore (for supersede/merge)'),
      reason: z.string().optional().describe('Explanation for the resolution'),
      session_id: z.string().optional().describe('Session where this resolution occurred'),
    },
    async (args) => {
      const now = epochSeconds();

      // Update spore status
      const statusMap: Record<string, string> = {
        supersede: 'superseded',
        archive: 'archived',
        merge: 'merged',
        split: 'split',
        consolidate: 'consolidated',
      };
      const newStatus = statusMap[args.action] ?? args.action;
      const updatedSpore = updateSporeStatus(args.spore_id, newStatus, now);

      // Record resolution event
      const eventId = crypto.randomUUID();
      insertResolutionEvent({
        id: eventId,
        agent_id: agentId,
        spore_id: args.spore_id,
        action: args.action,
        new_spore_id: args.new_spore_id ?? null,
        reason: args.reason ?? null,
        session_id: args.session_id ?? null,
        created_at: now,
      });

      if (newStatus !== 'active') {
        try { embeddingManager?.onStatusChanged('spores', args.spore_id, newStatus); } catch { /* best-effort */ }
      }

      recordTurn('vault_resolve_spore', args);
      return textResult({ spore: updatedSpore, resolution_event_id: eventId });
    },
  );

  const vaultUpdateSession = tool(
    'vault_update_session',
    'Update a session title and/or summary. When generating for the first time, provide BOTH title and summary. Title should be under 80 characters and reflect the full session scope.',
    {
      session_id: z.string().describe('Session ID to update'),
      title: z.string().optional().describe('New session title'),
      summary: z.string().optional().describe('New session summary'),
    },
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.summary !== undefined) updates.summary = args.summary;

      const session = updateSession(args.session_id, updates);

      if (args.summary) {
        embeddingManager?.onContentWritten('sessions', args.session_id, args.summary, {}).catch(() => {});
      }

      recordTurn('vault_update_session', args);
      return textResult(session);
    },
  );

  const vaultSetState = tool(
    'vault_set_state',
    'Set a key-value state pair for the current agent. Used for bookmarks, cursors, and preferences.',
    {
      key: z.string().describe('State key (e.g., last_processed_batch_id, cursor)'),
      value: z.string().describe('State value (stored as text)'),
    },
    async (args) => {
      const now = epochSeconds();
      const state = setState(agentId, args.key, args.value, now);

      recordTurn('vault_set_state', args);
      return textResult(state);
    },
  );

  const vaultReadDigest = tool(
    'vault_read_digest',
    'Read current digest extracts. Without a tier parameter, returns a summary of all tiers (content length, generation time). With a tier parameter, returns the full content for that specific tier.',
    {
      tier: z.number().optional().describe('Specific tier to read in full (e.g., 1500, 5000, 10000). Omit to get summary of all tiers.'),
    },
    async (args) => {
      recordTurn('vault_read_digest', args);
      const extracts = listDigestExtracts(agentId);

      if (args.tier !== undefined) {
        const extract = extracts.find(e => e.tier === args.tier);
        if (!extract) return textResult({ tier: args.tier, content: null, message: 'No digest at this tier' });
        return textResult({ tier: extract.tier, content: extract.content, generated_at: extract.generated_at });
      }

      // Summary mode — return metadata for all tiers
      return textResult(extracts.map(e => ({
        tier: e.tier,
        content_length: e.content.length,
        generated_at: e.generated_at,
      })));
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultWriteDigest = tool(
    'vault_write_digest',
    'Write or update a digest extract at a specific token tier. Uses UPSERT on (agent_id, tier).',
    {
      tier: z.number().describe('Token budget tier (e.g., 1500, 5000, 10000)'),
      content: z.string().describe('The digest extract content in markdown'),
    },
    async (args) => {
      const now = epochSeconds();

      const extract = upsertDigestExtract({
        agent_id: agentId,
        tier: args.tier,
        content: args.content,
        generated_at: now,
      });

      recordTurn('vault_write_digest', args);
      return textResult(extract);
    },
  );

  const vaultMarkProcessed = tool(
    'vault_mark_processed',
    'Mark a prompt batch as processed so it is not returned by vault_unprocessed.',
    {
      batch_id: z.number().describe('ID of the prompt batch to mark as processed'),
    },
    async (args) => {
      const batch = markBatchProcessed(args.batch_id);

      recordTurn('vault_mark_processed', args);
      return textResult(batch);
    },
  );

  // -------------------------------------------------------------------------
  // Observability tool
  // -------------------------------------------------------------------------

  const vaultReport = tool(
    'vault_report',
    'Record an observability report for the current run. Use action "skip" when skipping expected operations (e.g., not updating a session summary) with reasoning in the summary field.',
    {
      action: z.string().describe('Action name (e.g., extract, consolidate, digest, skip)'),
      summary: z.string().describe('Human-readable summary of what was done'),
      details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs'),
    },
    async (args) => {
      recordTurn('vault_report', args);
      const now = epochSeconds();

      const report = insertReport({
        run_id: runId,
        agent_id: agentId,
        action: args.action,
        summary: args.summary,
        details: args.details ? JSON.stringify(args.details) : null,
        created_at: now,
      });

      return textResult(report);
    },
  );

  // -------------------------------------------------------------------------
  // Assemble and return
  // -------------------------------------------------------------------------

  return [
    vaultUnprocessed,
    vaultSpores,
    vaultSessions,
    vaultSearchFts,
    vaultSearchSemantic,
    vaultState,
    vaultEntities,
    vaultEdges,
    vaultCreateSpore,
    vaultCreateEntity,
    vaultCreateEdge,
    vaultResolveSpore,
    vaultUpdateSession,
    vaultSetState,
    vaultReadDigest,
    vaultWriteDigest,
    vaultMarkProcessed,
    vaultReport,
  ];
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create a vault MCP tool server with 18 tools for the agent.
 *
 * Wraps `createVaultTools()` with `createSdkMcpServer()` from the
 * Claude Agent SDK.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @returns an MCP server config with instance, suitable for the SDK.
 */
export function createVaultToolServer(agentId: string, runId: string, embeddingManager?: EmbeddingManager) {
  const tools = createVaultTools(agentId, runId, 0, embeddingManager);

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools,
  });
}

/**
 * Create a vault MCP tool server scoped to a subset of tools.
 *
 * Used by the phased executor to restrict each phase to only the tools
 * it needs. Tools not in `toolNames` are excluded from the server.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @param toolNames — tool names to include (e.g., ['vault_unprocessed', 'vault_create_spore']).
 * @returns an MCP server config with only the specified tools.
 */
export function createScopedVaultToolServer(
  agentId: string,
  runId: string,
  toolNames: string[],
  turnOffset = 0,
  embeddingManager?: EmbeddingManager,
) {
  const allTools = createVaultTools(agentId, runId, turnOffset, embeddingManager);
  const nameSet = new Set(toolNames);
  const scopedTools = allTools.filter((t) => nameSet.has(t.name));

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools: scopedTools,
  });
}
