/**
 * myco_skills — list and inspect skills.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillsInput {
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
  if (input.id) {
    const result = await client.get(`/api/skill-records/${encodeURIComponent(input.id)}`);
    if (!result.ok || !result.data) return { error: 'Skill not found' };
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
