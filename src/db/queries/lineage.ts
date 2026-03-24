/**
 * Lineage edge creation helpers.
 *
 * Creates automatic graph edges when spores and batches are inserted.
 * These are structural (no LLM needed) — the daemon layer calls them.
 *
 * Edge types created:
 * - FROM_SESSION: spore → session (the session it was extracted from)
 * - EXTRACTED_FROM: spore → batch (the prompt batch it was extracted from)
 * - DERIVED_FROM: wisdom spore → source spore (consolidation provenance)
 * - HAS_BATCH: session → batch (prompt batch belongs to session)
 */

import { insertGraphEdge } from './graph-edges.js';

// ---------------------------------------------------------------------------
// Spore lineage
// ---------------------------------------------------------------------------

/** Create lineage edges for a newly inserted spore. Fire-and-forget safe. */
export async function createSporeLineage(spore: {
  id: string;
  agent_id: string;
  session_id?: string | null;
  prompt_batch_id?: number | null;
  observation_type?: string;
  properties?: string | null;
  created_at: number;
}): Promise<void> {
  if (spore.session_id) {
    await insertGraphEdge({
      agent_id: spore.agent_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: spore.session_id,
      target_type: 'session',
      type: 'FROM_SESSION',
      created_at: spore.created_at,
    });
  }

  if (spore.prompt_batch_id != null) {
    await insertGraphEdge({
      agent_id: spore.agent_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: String(spore.prompt_batch_id),
      target_type: 'batch',
      type: 'EXTRACTED_FROM',
      created_at: spore.created_at,
    });
  }

  // DERIVED_FROM edges for wisdom spores
  if (spore.observation_type === 'wisdom' && spore.properties) {
    try {
      const props = JSON.parse(spore.properties);
      if (Array.isArray(props.consolidated_from)) {
        for (const sourceId of props.consolidated_from) {
          await insertGraphEdge({
            agent_id: spore.agent_id,
            source_id: spore.id,
            source_type: 'spore',
            target_id: sourceId,
            target_type: 'spore',
            type: 'DERIVED_FROM',
            created_at: spore.created_at,
          });
        }
      }
    } catch { /* ignore malformed properties */ }
  }
}

// ---------------------------------------------------------------------------
// Batch lineage
// ---------------------------------------------------------------------------

/** Create a HAS_BATCH lineage edge from session to batch. */
export async function createBatchLineage(
  agentId: string,
  sessionId: string,
  batchId: number,
  createdAt: number,
): Promise<void> {
  await insertGraphEdge({
    agent_id: agentId,
    source_id: sessionId,
    source_type: 'session',
    target_id: String(batchId),
    target_type: 'batch',
    type: 'HAS_BATCH',
    created_at: createdAt,
  });
}
