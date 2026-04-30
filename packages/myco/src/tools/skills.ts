/**
 * myco_skills — list and inspect skills.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { extractErrorMessage } from './error.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillsInput {
  op?: 'list' | 'get';
  id?: string;
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleMycoSkills(
  input: SkillsInput,
  client: DaemonClient,
): Promise<unknown> {
  const op = input.op ?? 'list';
  if (op === 'get') {
    if (!input.id) return { ok: false, error: 'id is required for op: get' };
    const result = await client.get(`/api/skill-records/${encodeURIComponent(input.id)}`);
    if (!result.ok || !result.data) {
      return { ok: false, error: extractErrorMessage(result.data, 'Skill not found') };
    }
    return result.data;
  }

  const endpoint = buildEndpoint('/api/skill-records', {
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.records) return [];

  return result.data.records;
}
