/**
 * myco_skills / myco_skill_candidates — list, inspect, and manage skills.
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

interface SkillCandidatesInput {
  id?: string;
  action?: 'list' | 'approve' | 'dismiss';
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

export async function handleMycoSkillCandidates(
  input: SkillCandidatesInput,
  client: DaemonClient,
): Promise<unknown> {
  const action = input.action ?? 'list';

  // Approve or dismiss require an id
  if (action === 'approve' || action === 'dismiss') {
    if (!input.id) {
      return { error: `Action '${action}' requires an id` };
    }
    const status = action === 'approve' ? 'approved' : 'dismissed';
    const result = await client.put(`/api/skill-candidates/${encodeURIComponent(input.id)}`, { status });
    if (!result.ok || !result.data) {
      return { error: `Failed to ${action} candidate` };
    }
    return result.data;
  }

  // List / get by id
  if (input.id) {
    const result = await client.get(`/api/skill-candidates/${encodeURIComponent(input.id)}`);
    if (!result.ok || !result.data) return { error: 'Candidate not found' };
    return result.data;
  }

  const endpoint = buildEndpoint('/api/skill-candidates', {
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.candidates) return [];

  return result.data.candidates;
}
