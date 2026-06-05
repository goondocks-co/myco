/**
 * Write vault tools.
 *
 * 7 tools: vault_create_spore, vault_resolve_spore, vault_update_session,
 * vault_set_state, vault_read_digest, vault_write_digest, vault_mark_processed
 */

import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds, DIGEST_TIERS } from '@myco/constants.js';
import { getSpore, insertSpore, DEFAULT_IMPORTANCE } from '@myco/db/queries/spores.js';
import { updateSession } from '@myco/db/queries/sessions.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { OBSERVATION_TYPES } from '../../vault/types.js';
import { RESOLUTION_ACTIONS, SPORE_STATUS } from '@myco/constants/spore-status.js';
import { applySporeResolution } from '@myco/spores/write.js';
import { markBatchProcessed } from '@myco/db/queries/batches.js';
import { createSporeLineage } from '@myco/db/queries/lineage.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import { requireProjectId } from '@myco/grove/request-context.js';
import { upsertDigestExtract, listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { textResult, dryRunResult, projectScopeFromVaultToolDeps, rowProjectIdFromVaultToolDeps, type VaultToolDeps } from './types.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWriteTools(deps: VaultToolDeps) {
  const { agentId, embeddingManager, machineId, requestContext } = deps;
  const projectId = rowProjectIdFromVaultToolDeps(deps);
  const scope = projectScopeFromVaultToolDeps(deps);

  const vaultCreateSpore = tool(
    'vault_create_spore',
    'Create a new spore (observation) in the vault. The agent_id is set automatically.',
    {
      observation_type: z
        .enum(OBSERVATION_TYPES)
        .describe(
          `Spore kind. Direct extraction: gotcha, bug_fix, decision, discovery, trade_off, cross-cutting. Synthesized (consolidation / seed): wisdom, pattern, architecture.`,
        ),
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
        project_id: projectId,
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

      // Best-effort: structural lineage edges (FROM_SESSION, EXTRACTED_FROM, DERIVED_FROM).
      // SporeRow.project_id is `string | null` from the DB; brand it via the
      // single mint site before threading into the writer.
      try {
        const lineageProjectId = spore.project_id ? assertGroveProjectId(spore.project_id) : null;
        createSporeLineage({ ...spore, project_id: lineageProjectId });
      } catch { /* lineage best-effort */ }

      embeddingManager?.onContentWritten('spores', spore.id, args.content, {
        status: 'active',
        observation_type: args.observation_type,
        session_id: args.session_id,
        ...(typeof projectId === 'string' ? { project_id: projectId } : {}),
        created_at: now,
      }).catch(() => {});

      return textResult(spore);
    },
    { annotations: { openWorldHint: true } },
  );

  const vaultResolveSpore = tool(
    'vault_resolve_spore',
    'Resolve a spore by updating its status and recording a resolution event.',
    {
      spore_id: z.string().describe('ID of the spore to resolve'),
      action: z
        .enum(RESOLUTION_ACTIONS)
        .describe(
          'Resolution action: supersede (replaced by a newer spore), consolidate (merged into a wisdom note), or obsolete (no longer relevant, no replacement)',
        ),
      new_spore_id: z.string().optional().describe('ID of the replacement spore (required for supersede)'),
      reason: z.string().optional().describe('Explanation for the resolution'),
      session_id: z.string().optional().describe('Session where this resolution occurred'),
    },
    async (args) => {
      if (!getSpore(args.spore_id, scope)) {
        return textResult({ error: `Spore not found: ${args.spore_id}` });
      }
      if (args.new_spore_id && !getSpore(args.new_spore_id, scope)) {
        return textResult({ error: `Replacement spore not found: ${args.new_spore_id}` });
      }

      const result = applySporeResolution({
        spore_id: args.spore_id,
        action: args.action,
        new_spore_id: args.new_spore_id ?? null,
        reason: args.reason ?? null,
        session_id: args.session_id ?? null,
        scope,
        project_id: projectId,
        agent_id: agentId,
        machine_id: machineId,
      });
      if ('ok' in result) {
        return textResult({ error: result.error });
      }

      if (result.status !== SPORE_STATUS.ACTIVE) {
        try { embeddingManager?.onStatusChanged('spores', args.spore_id, result.status); } catch { /* best-effort */ }
      }

      return textResult({ spore: result.spore, resolution_event_id: result.resolution_event_id });
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

      const session = updateSession(args.session_id, updates, scope);

      if (!session) {
        return textResult({ error: `Session not found: ${args.session_id}` });
      }

      if (args.summary) {
        embeddingManager?.onContentWritten('sessions', args.session_id, args.summary, {
          ...(typeof projectId === 'string' ? { project_id: projectId } : {}),
        }).catch(() => {});
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
      const state = setState(agentId, requireProjectId(requestContext!, 'agent state write'), args.key, args.value, now);

      return textResult(state);
    },
    { annotations: { idempotentHint: true } },
  );

  const vaultReadDigest = tool(
    'vault_read_digest',
    'Read current digest extracts. Three modes: (1) no args → summary metadata for all tiers; (2) tier → full content for that tier; (3) pick: "rotate_oldest" → the digest-rotation decision, returning the tier whose generated_at is oldest plus its full content (or skip:true when all tiers are fresher than min_staleness_seconds). The rotation mode lets callers outsource the "which tier should we update this run" choice to a deterministic tool decision instead of prompting the LLM to compare timestamps.',
    {
      tier: z.number().optional().describe('Specific tier to read in full (e.g., 1500, 5000, 10000). Omit to get summary of all tiers. Ignored when pick is set.'),
      pick: z.enum(['rotate_oldest']).optional().describe('Rotation mode. "rotate_oldest" picks the tier with the oldest generated_at (missing tiers count as never-generated and sort first). The response includes the selected tier, its full content, a rotation_reason explaining the choice, and metadata for all tiers so the caller can audit the decision.'),
      min_staleness_seconds: z.number().optional().describe('Used with pick="rotate_oldest". If every tier\'s generated_at is newer than (now - min_staleness_seconds), the tool returns {skip: true, reason, all_tiers} instead of selecting a tier. Defaults to 0 (never skip).'),
    },
    async (args) => {
      const extracts = listDigestExtracts(agentId, scope);

      if (args.pick === 'rotate_oldest') {
        const now = epochSeconds();
        const canonical = DIGEST_TIERS.map((tier) => {
          const existing = extracts.find((e) => e.tier === tier);
          return {
            tier,
            generated_at: existing?.generated_at ?? 0,
            content_length: existing?.content.length ?? 0,
            content: existing?.content ?? null,
          };
        });

        const minStale = args.min_staleness_seconds ?? 0;
        if (minStale > 0) {
          const allPresent = canonical.every((t) => t.generated_at > 0);
          const cutoff = now - minStale;
          const allFresh = canonical.every((t) => t.generated_at > cutoff);
          if (allPresent && allFresh) {
            return textResult({
              mode: 'rotate_oldest',
              skip: true,
              reason: `All ${canonical.length} tiers were generated within the last ${minStale} seconds (cutoff=${cutoff}).`,
              all_tiers: canonical.map((t) => ({ tier: t.tier, generated_at: t.generated_at, content_length: t.content_length })),
            });
          }
        }

        // Tie-break: on a fresh vault with no extracts, seed the largest
        // tier first so subsequent runs have content to compress down from.
        const sorted = [...canonical].sort((a, b) => {
          if (a.generated_at !== b.generated_at) return a.generated_at - b.generated_at;
          return b.tier - a.tier;
        });
        const selected = sorted[0];
        const reason = selected.generated_at === 0
          ? `Tier ${selected.tier} has never been generated — seeding.`
          : `Tier ${selected.tier} has the oldest generated_at (${selected.generated_at}); next oldest is tier ${sorted[1]?.tier} at ${sorted[1]?.generated_at}.`;

        return textResult({
          mode: 'rotate_oldest',
          selected_tier: selected.tier,
          selected_generated_at: selected.generated_at,
          selected_content: selected.content,
          rotation_reason: reason,
          all_tiers: canonical.map((t) => ({ tier: t.tier, generated_at: t.generated_at, content_length: t.content_length })),
        });
      }

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
        project_id: projectId,
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
      const batch = markBatchProcessed(args.batch_id, scope);

      if (!batch) {
        return textResult({ error: `Prompt batch not found: ${args.batch_id}` });
      }
      return textResult(batch);
    },
    { annotations: { destructiveHint: true } },
  );

  return [
    vaultCreateSpore,
    vaultResolveSpore,
    vaultUpdateSession,
    vaultSetState,
    vaultReadDigest,
    vaultWriteDigest,
    vaultMarkProcessed,
  ];
}
