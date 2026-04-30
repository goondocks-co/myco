/**
 * myco_consolidate — merge related spores into a single wisdom spore.
 *
 * Proxies through the daemon HTTP API via DaemonClient. The daemon inserts a
 * new spore with the consolidated content, then for each source spore marks
 * status='superseded' and records a resolution_events row linking it to the
 * new wisdom spore.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsolidateInput {
  source_spore_ids: string[];
  consolidated_content: string;
  observation_type: string;
  tags?: string[];
  reason?: string;
}

interface ConsolidateResult {
  new_spore_id: string;
  sources_superseded: string[];
  status: 'consolidated';
  created_at: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoConsolidate(
  input: ConsolidateInput,
  client: DaemonClient,
): Promise<ConsolidateResult> {
  const result = await client.post('/api/mcp/consolidate', {
    source_spore_ids: input.source_spore_ids,
    consolidated_content: input.consolidated_content,
    observation_type: input.observation_type,
    tags: input.tags,
    reason: input.reason,
  });

  if (!result.ok || !result.data) {
    throw new Error('Failed to consolidate spores: daemon request failed');
  }

  return result.data as ConsolidateResult;
}
