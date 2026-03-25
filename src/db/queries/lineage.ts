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
import { listEntities } from './entities.js';
import { listSpores } from './spores.js';
import {
  EDGE_TYPE_FROM_SESSION,
  EDGE_TYPE_EXTRACTED_FROM,
  EDGE_TYPE_DERIVED_FROM,
  EDGE_TYPE_HAS_BATCH,
  EDGE_TYPE_REFERENCES,
} from '@myco/constants.js';

/** Minimum entity name length to match (avoids false positives on short names). */
const MIN_ENTITY_NAME_LENGTH = 3;

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

// ---------------------------------------------------------------------------
// Entity ↔ Spore auto-linking (REFERENCES edges)
// ---------------------------------------------------------------------------

/**
 * Check if spore content mentions an entity name (case-insensitive word boundary match).
 */
function contentMentionsEntity(content: string, entityName: string): boolean {
  if (entityName.length < MIN_ENTITY_NAME_LENGTH) return false;
  // Escape regex special chars in entity name, match case-insensitive
  const escaped = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  return pattern.test(content);
}

/**
 * Auto-link a newly created spore to existing entities whose name appears in its content.
 * Creates REFERENCES edges (spore → entity). Fire-and-forget safe.
 */
export async function autoLinkSporeToEntities(spore: {
  id: string;
  agent_id: string;
  content: string;
  created_at: number;
}): Promise<number> {
  const entities = await listEntities({ agent_id: spore.agent_id, status: 'active' });
  const edges: Promise<unknown>[] = [];

  for (const entity of entities) {
    if (contentMentionsEntity(spore.content, entity.name)) {
      edges.push(insertGraphEdge({
        agent_id: spore.agent_id,
        source_id: spore.id,
        source_type: 'spore',
        target_id: entity.id,
        target_type: 'entity',
        type: EDGE_TYPE_REFERENCES,
        created_at: spore.created_at,
      }));
    }
  }

  await Promise.all(edges);
  return edges.length;
}

/**
 * Auto-link a newly created entity to existing spores whose content mentions it.
 * Creates REFERENCES edges (spore → entity). Fire-and-forget safe.
 */
export async function autoLinkEntityToSpores(entity: {
  id: string;
  agent_id: string;
  name: string;
  created_at: number;
}): Promise<number> {
  if (entity.name.length < MIN_ENTITY_NAME_LENGTH) return 0;

  const spores = await listSpores({ agent_id: entity.agent_id, status: 'active' });
  const edges: Promise<unknown>[] = [];

  for (const spore of spores) {
    if (contentMentionsEntity(spore.content, entity.name)) {
      edges.push(insertGraphEdge({
        agent_id: entity.agent_id,
        source_id: spore.id,
        source_type: 'spore',
        target_id: entity.id,
        target_type: 'entity',
        type: EDGE_TYPE_REFERENCES,
        created_at: entity.created_at,
      }));
    }
  }

  await Promise.all(edges);
  return edges.length;
}
