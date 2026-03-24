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
// Lineage edge type constants
// ---------------------------------------------------------------------------

/** Spore was extracted during this session. */
export const EDGE_TYPE_FROM_SESSION = 'FROM_SESSION';

/** Spore was extracted from this prompt batch. */
export const EDGE_TYPE_EXTRACTED_FROM = 'EXTRACTED_FROM';

/** Wisdom spore was derived from (consolidated) this source spore. */
export const EDGE_TYPE_DERIVED_FROM = 'DERIVED_FROM';

/** Session contains this prompt batch. */
export const EDGE_TYPE_HAS_BATCH = 'HAS_BATCH';

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
  // Structural edges — independent, run concurrently
  const structural: Promise<unknown>[] = [];

  if (spore.session_id) {
    structural.push(insertGraphEdge({
      agent_id: spore.agent_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: spore.session_id,
      target_type: 'session',
      type: EDGE_TYPE_FROM_SESSION,
      created_at: spore.created_at,
    }));
  }

  if (spore.prompt_batch_id != null) {
    structural.push(insertGraphEdge({
      agent_id: spore.agent_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: String(spore.prompt_batch_id),
      target_type: 'batch',
      type: EDGE_TYPE_EXTRACTED_FROM,
      created_at: spore.created_at,
    }));
  }

  // DERIVED_FROM edges for wisdom spores — also concurrent
  if (spore.observation_type === 'wisdom' && spore.properties) {
    try {
      const props = JSON.parse(spore.properties);
      if (Array.isArray(props.consolidated_from)) {
        for (const sourceId of props.consolidated_from) {
          structural.push(insertGraphEdge({
            agent_id: spore.agent_id,
            source_id: spore.id,
            source_type: 'spore',
            target_id: sourceId,
            target_type: 'spore',
            type: EDGE_TYPE_DERIVED_FROM,
            created_at: spore.created_at,
          }));
        }
      }
    } catch { /* ignore malformed properties */ }
  }

  await Promise.all(structural);
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
    type: EDGE_TYPE_HAS_BATCH,
    created_at: createdAt,
  });
}
