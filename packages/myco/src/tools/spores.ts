/**
 * myco_spores — list, retrieve, save, supersede, or consolidate spores.
 *
 * Write ops call the in-process services in `spores/write.ts`. Read ops go
 * through the daemon's `/api/spores` REST surface (the same endpoints that
 * back the daemon UI).
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { saveSpore, supersedeSpore, consolidateSpores } from '@myco/spores/write.js';
import { type ToolFailure } from './error.js';
import { buildEndpoint } from './shared.js';

export interface SporesInput {
  op?: 'list' | 'get' | 'save' | 'supersede' | 'consolidate';
  id?: string;
  content?: string;
  type?: string;
  observation_type?: string;
  status?: string;
  agent_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
  old_spore_id?: string;
  new_spore_id?: string;
  source_spore_ids?: string[];
  consolidated_content?: string;
  tags?: string[];
  reason?: string;
}

export async function handleMycoSpores(
  input: SporesInput,
  client: DaemonClient,
): Promise<unknown | ToolFailure> {
  const op = input.op ?? 'list';

  if (op === 'get') {
    if (!input.id) return { ok: false, error: 'id is required for op: get' };
    const result = await client.get(`/api/spores/${encodeURIComponent(input.id)}`);
    if (!result.ok || !result.data) return { ok: false, error: 'Spore not found' };
    return result.data;
  }

  if (op === 'save') {
    if (!input.content) return { ok: false, error: 'content is required for op: save' };
    if (!input.type) return { ok: false, error: 'type is required for op: save' };
    return saveSpore({ content: input.content, type: input.type, tags: input.tags });
  }

  if (op === 'supersede') {
    if (!input.old_spore_id) return { ok: false, error: 'old_spore_id is required for op: supersede' };
    if (!input.new_spore_id) return { ok: false, error: 'new_spore_id is required for op: supersede' };
    return supersedeSpore({
      old_spore_id: input.old_spore_id,
      new_spore_id: input.new_spore_id,
      reason: input.reason,
    });
  }

  if (op === 'consolidate') {
    if (!input.source_spore_ids?.length) return { ok: false, error: 'source_spore_ids is required for op: consolidate' };
    if (!input.consolidated_content) return { ok: false, error: 'consolidated_content is required for op: consolidate' };
    if (!input.observation_type) return { ok: false, error: 'observation_type is required for op: consolidate' };
    return consolidateSpores({
      source_spore_ids: input.source_spore_ids,
      consolidated_content: input.consolidated_content,
      observation_type: input.observation_type,
      tags: input.tags,
      reason: input.reason,
    });
  }

  const endpoint = buildEndpoint('/api/spores', {
    agent_id: input.agent_id,
    type: input.observation_type ?? input.type,
    status: input.status,
    search: input.search,
    limit: input.limit,
    offset: input.offset,
  });
  const result = await client.get(endpoint);
  if (!result.ok || !result.data) return { spores: [], total: 0, offset: input.offset ?? 0, limit: input.limit };
  return result.data;
}
