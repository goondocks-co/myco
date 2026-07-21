/**
 * Lineage edge creation helpers.
 *
 * Creates automatic graph edges when spores and batches are inserted.
 * These are structural (no LLM needed) — the daemon layer calls them.
 *
 * Edge types created:
 * - FROM_SESSION: spore -> session (the session it was extracted from)
 * - EXTRACTED_FROM: spore -> batch (the prompt batch it was extracted from)
 * - DERIVED_FROM: wisdom spore -> source spore (consolidation provenance)
 * - HAS_BATCH: session -> batch (prompt batch belongs to session)
 */

import { insertGraphEdge, listGraphEdges } from './graph-edges.js';
import { ALL_PROJECTS_SCOPE, type GroveProjectId } from '@myco/grove/ids.js';
import {
  EDGE_TYPE_FROM_SESSION,
  EDGE_TYPE_EXTRACTED_FROM,
  EDGE_TYPE_DERIVED_FROM,
  EDGE_TYPE_HAS_BATCH,
  DEFAULT_AGENT_ID,
  epochSeconds,
} from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Spore lineage
// ---------------------------------------------------------------------------

/** Create lineage edges for a newly inserted spore. */
export function createSporeLineage(spore: {
  id: string;
  agent_id: string;
  project_id?: GroveProjectId | null;
  session_id?: string | null;
  prompt_batch_id?: string | null;
  observation_type?: string;
  properties?: string | null;
  created_at: number;
}): void {
  if (spore.session_id) {
    insertGraphEdge({
      agent_id: spore.agent_id,
      project_id: spore.project_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: spore.session_id,
      target_type: 'session',
      type: EDGE_TYPE_FROM_SESSION,
      created_at: spore.created_at,
    });
  }

  if (spore.prompt_batch_id != null) {
    insertGraphEdge({
      agent_id: spore.agent_id,
      project_id: spore.project_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: String(spore.prompt_batch_id),
      target_type: 'batch',
      type: EDGE_TYPE_EXTRACTED_FROM,
      created_at: spore.created_at,
    });
  }

  // DERIVED_FROM edges for wisdom spores
  if (spore.observation_type === 'wisdom' && spore.properties) {
    try {
      const props = JSON.parse(spore.properties);
      if (Array.isArray(props.consolidated_from)) {
        for (const sourceId of props.consolidated_from) {
          insertGraphEdge({
            agent_id: spore.agent_id,
            project_id: spore.project_id,
            source_id: spore.id,
            source_type: 'spore',
            target_id: sourceId,
            target_type: 'spore',
            type: EDGE_TYPE_DERIVED_FROM,
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
export function createBatchLineage(
  agentId: string,
  sessionId: string,
  batchId: string,
  createdAt: number,
  projectId: GroveProjectId | null,
): void {
  insertGraphEdge({
    agent_id: agentId,
    project_id: projectId,
    source_id: sessionId,
    source_type: 'session',
    target_id: String(batchId),
    target_type: 'batch',
    type: EDGE_TYPE_HAS_BATCH,
    created_at: createdAt,
  });
}

// ---------------------------------------------------------------------------
// Plan touch lineage
// ---------------------------------------------------------------------------

/** Minimal plan shape needed to attribute a cross-session touch edge. */
export interface PlanTouchTarget {
  id: string;
  project_id: string | null;
  session_id: string | null;
}

/**
 * Record a deliberate cross-session interaction with a plan as a lineage edge
 * (plan -> calling session). No-op when the caller IS the plan's creating
 * session or when there is no calling session. Deduplicated on
 * (source_id, target_id, type) so repeated retrievals don't multiply edges.
 *
 * Best-effort: this is auxiliary provenance attached to the MCP op:get / op:save
 * path, so a failure here must never break the caller's plan retrieval or save.
 * Attributed to DEFAULT_AGENT_ID — the same system owner createBatchLineage
 * uses, which satisfies the agent FK in every running daemon.
 */
export function recordPlanSessionTouch(
  plan: PlanTouchTarget,
  callingSessionId: string | null | undefined,
  type: 'PLAN_REFERENCED' | 'PLAN_ADVANCED',
): void {
  if (!callingSessionId) return;
  if (callingSessionId === plan.session_id) return;

  try {
    const alreadyLinked = listGraphEdges({
      sourceId: plan.id,
      targetId: callingSessionId,
      type,
      scope: ALL_PROJECTS_SCOPE,
      limit: 1,
    }).length > 0;
    if (alreadyLinked) return;

    insertGraphEdge({
      agent_id: DEFAULT_AGENT_ID,
      project_id: plan.project_id,
      source_id: plan.id,
      source_type: 'plan',
      target_id: callingSessionId,
      target_type: 'session',
      type,
      session_id: callingSessionId,
      created_at: epochSeconds(),
    });
  } catch {
    // Best-effort lineage — never break the plan tool call.
  }
}
