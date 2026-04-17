/**
 * Write vault tools.
 *
 * 9 tools: vault_create_spore, vault_create_entity, vault_create_edge,
 * vault_resolve_spore, vault_update_session, vault_set_state,
 * vault_read_digest, vault_write_digest, vault_mark_processed
 */

import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { insertSpore, updateSporeStatus, DEFAULT_IMPORTANCE } from '@myco/db/queries/spores.js';
import { updateSession } from '@myco/db/queries/sessions.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { markBatchProcessed } from '@myco/db/queries/batches.js';
import { insertEntity } from '@myco/db/queries/entities.js';
import { insertGraphEdge } from '@myco/db/queries/graph-edges.js';
import { createSporeLineage } from '@myco/db/queries/lineage.js';
import { insertResolutionEvent } from '@myco/db/queries/resolution-events.js';
import { upsertDigestExtract, listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { textResult, dryRunResult, type VaultToolDeps } from './types.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWriteTools(deps: VaultToolDeps) {
  const { agentId, embeddingManager, machineId } = deps;

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
        machine_id: machineId,
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

      return textResult(spore);
    },
    { annotations: { openWorldHint: true } },
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
        machine_id: machineId,
        type: args.type,
        name: args.name,
        properties: props,
        first_seen: now,
        last_seen: now,
      });

      return textResult(entity);
    },
    { annotations: { idempotentHint: true } },
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
        machine_id: machineId,
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

      return textResult(edge);
    },
    { annotations: { idempotentHint: true } },
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
        machine_id: machineId,
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

      return textResult({ spore: updatedSpore, resolution_event_id: eventId });
    },
    { annotations: { destructiveHint: true } },
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

      if (!session) {
        return textResult({ error: `Session not found: ${args.session_id}` });
      }
      return textResult(session);
    },
    { annotations: { idempotentHint: true } },
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

      return textResult(state);
    },
    { annotations: { idempotentHint: true } },
  );

  const vaultReadDigest = tool(
    'vault_read_digest',
    'Read current digest extracts. Without a tier parameter, returns a summary of all tiers (content length, generation time). With a tier parameter, returns the full content for that specific tier.',
    {
      tier: z.number().optional().describe('Specific tier to read in full (e.g., 1500, 5000, 10000). Omit to get summary of all tiers.'),
    },
    async (args) => {
      const extracts = listDigestExtracts(agentId);

      if (args.tier !== undefined) {
        const extract = extracts.find(e => e.tier === args.tier);
        if (!extract) return textResult({ tier: args.tier, content: null, message: 'No digest at this tier' });
        return textResult({ tier: extract.tier, content: extract.content, generated_at: extract.generated_at });
      }

      // Summary mode -- return metadata for all tiers
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

      // `upsertDigestExtract` returns `null` when called in dry-run mode.
      // Task 1 does not plumb dryRun here yet — Task 2 will — but we must
      // null-guard now so the contract stays honest: returning `textResult(null)`
      // would serialize as the string "null" and lie to the agent about
      // whether the digest was written.
      const extract = upsertDigestExtract({
        agent_id: agentId,
        tier: args.tier,
        content: args.content,
        generated_at: now,
      });

      if (!extract) {
        return dryRunResult('vault_write_digest', {
          tier: args.tier,
          reason: 'dry-run mode active; no digest written',
        });
      }
      return textResult(extract);
    },
    { annotations: { idempotentHint: true } },
  );

  const vaultMarkProcessed = tool(
    'vault_mark_processed',
    'Mark a prompt batch as processed so it is not returned by vault_unprocessed.',
    {
      batch_id: z.number().describe('ID of the prompt batch to mark as processed'),
    },
    async (args) => {
      const batch = markBatchProcessed(args.batch_id);

      if (!batch) {
        return textResult({ error: `Prompt batch not found: ${args.batch_id}` });
      }
      return textResult(batch);
    },
    { annotations: { destructiveHint: true } },
  );

  return [
    vaultCreateSpore,
    vaultCreateEntity,
    vaultCreateEdge,
    vaultResolveSpore,
    vaultUpdateSession,
    vaultSetState,
    vaultReadDigest,
    vaultWriteDigest,
    vaultMarkProcessed,
  ];
}
