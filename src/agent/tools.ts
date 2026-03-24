/**
 * Vault MCP tool server for the agent.
 *
 * Creates 14 tools that expose PGlite query helpers to the agent
 * via the Claude Agent SDK. Tools are grouped into:
 * - Read tools: vault_unprocessed, vault_spores, vault_sessions, vault_search, vault_state
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
import { epochSeconds } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { getUnprocessedBatches, markBatchProcessed } from '@myco/db/queries/batches.js';
import { listSpores, insertSpore, updateSporeStatus, DEFAULT_IMPORTANCE } from '@myco/db/queries/spores.js';
import { listSessions, updateSession } from '@myco/db/queries/sessions.js';
import { getStatesForAgent, setState } from '@myco/db/queries/agent-state.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { searchSimilar, EMBEDDABLE_TABLES, type EmbeddableTable } from '@myco/db/queries/embeddings.js';
import { insertEntity } from '@myco/db/queries/entities.js';
import { insertGraphEdge } from '@myco/db/queries/graph-edges.js';
import { createSporeLineage } from '@myco/db/queries/lineage.js';
import { insertResolutionEvent } from '@myco/db/queries/resolution-events.js';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts.js';

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
export const VAULT_TOOL_COUNT = 14;

/**
 * Create the 14 vault tool definitions for the agent.
 *
 * Exposed for testing (call handler directly) and for the MCP server factory.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @returns array of SdkMcpToolDefinition objects.
 */
export function createVaultTools(agentId: string, runId: string) {
  /** Turn number counter — incremented per write tool call within a run. */
  let turnCounter = 0;

  /**
   * Record a turn in the audit trail for write operations.
   * Fire-and-forget — does not block the tool response.
   */
  function recordTurn(toolName: string, toolInput: unknown): void {
    turnCounter++;
    insertTurn({
      run_id: runId,
      agent_id: agentId,
      turn_number: turnCounter,
      tool_name: toolName,
      tool_input: JSON.stringify(toolInput),
      started_at: epochSeconds(),
    }).catch(() => {
      /* audit trail is best-effort */
    });
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
      const batches = await getUnprocessedBatches({
        after_id: args.after_id,
        limit: args.limit ?? DEFAULT_UNPROCESSED_LIMIT,
      });
      return textResult(batches);
    },
  );

  const vaultSpores = tool(
    'vault_spores',
    'List spores with optional filters (agent, observation type, status).',
    {
      agent_id: z.string().optional().describe('Filter by agent ID'),
      observation_type: z.string().optional().describe('Filter by observation type (e.g., gotcha, decision)'),
      status: z.enum(['active', 'superseded', 'archived']).optional().describe('Filter by status'),
      limit: z.number().optional().describe('Maximum number of spores to return'),
    },
    async (args) => {
      const spores = await listSpores({
        agent_id: args.agent_id,
        observation_type: args.observation_type,
        status: args.status,
        limit: args.limit ?? DEFAULT_SPORES_LIMIT,
      });
      return textResult(spores);
    },
  );

  const vaultSessions = tool(
    'vault_sessions',
    'List sessions with optional status filter, ordered by created_at DESC.',
    {
      limit: z.number().optional().describe('Maximum number of sessions to return'),
      status: z.string().optional().describe('Filter by status (active, completed)'),
    },
    async (args) => {
      const sessions = await listSessions({
        limit: args.limit ?? DEFAULT_SESSIONS_LIMIT,
        status: args.status,
      });
      return textResult(sessions);
    },
  );

  const vaultSearch = tool(
    'vault_search',
    'Semantic similarity search across vault content. Returns ranked results by cosine similarity. If no embeddings are available, returns an empty result set — use vault_spores or vault_sessions as a fallback.',
    {
      query: z.string().describe('Search query text to embed and compare'),
      table: z.enum(EMBEDDABLE_TABLES).optional().describe('Table to search'),
      limit: z.number().optional().describe('Maximum number of results to return'),
    },
    async (args) => {
      try {
        const { tryEmbed } = await import('@myco/intelligence/embed-query.js');
        const embedding = await tryEmbed(args.query);
        if (!embedding) {
          return textResult({ results: [], message: 'Embedding provider unavailable' });
        }

        const table = args.table ?? DEFAULT_SEARCH_TABLE;
        const results = await searchSimilar(table, embedding, {
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
        });
        return textResult({ results });
      } catch {
        return textResult({ results: [], message: 'Search unavailable' });
      }
    },
  );

  const vaultState = tool(
    'vault_state',
    'Get all state key-value pairs for the current agent.',
    {},
    async () => {
      const states = await getStatesForAgent(agentId);
      return textResult(states);
    },
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

      const spore = await insertSpore({
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

      // Fire-and-forget lineage edges — failure should not break spore creation
      try { await createSporeLineage(spore); } catch { /* lineage best-effort */ }

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

      const entity = await insertEntity({
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

      const edge = await insertGraphEdge({
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
      const updatedSpore = await updateSporeStatus(args.spore_id, newStatus, now);

      // Record resolution event
      const eventId = crypto.randomUUID();
      await insertResolutionEvent({
        id: eventId,
        agent_id: agentId,
        spore_id: args.spore_id,
        action: args.action,
        new_spore_id: args.new_spore_id ?? null,
        reason: args.reason ?? null,
        session_id: args.session_id ?? null,
        created_at: now,
      });

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

      const session = await updateSession(args.session_id, updates);

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
      const state = await setState(agentId, args.key, args.value, now);

      recordTurn('vault_set_state', args);
      return textResult(state);
    },
  );

  const vaultWriteDigest = tool(
    'vault_write_digest',
    'Write or update a digest extract at a specific token tier. Uses UPSERT on (agent_id, tier).',
    {
      tier: z.number().describe('Token budget tier (e.g., 1500, 3000, 5000, 7500, 10000)'),
      content: z.string().describe('The digest extract content in markdown'),
    },
    async (args) => {
      const now = epochSeconds();

      const extract = await upsertDigestExtract({
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
      const batch = await markBatchProcessed(args.batch_id);

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
      const now = epochSeconds();

      const report = await insertReport({
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
    vaultSearch,
    vaultState,
    vaultCreateSpore,
    vaultCreateEntity,
    vaultCreateEdge,
    vaultResolveSpore,
    vaultUpdateSession,
    vaultSetState,
    vaultWriteDigest,
    vaultMarkProcessed,
    vaultReport,
  ];
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create a vault MCP tool server with 14 tools for the agent.
 *
 * Wraps `createVaultTools()` with `createSdkMcpServer()` from the
 * Claude Agent SDK.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @returns an MCP server config with instance, suitable for the SDK.
 */
export function createVaultToolServer(agentId: string, runId: string) {
  const tools = createVaultTools(agentId, runId);

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
) {
  const allTools = createVaultTools(agentId, runId);
  const nameSet = new Set(toolNames);
  const scopedTools = allTools.filter((t) => nameSet.has(t.name));

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools: scopedTools,
  });
}
