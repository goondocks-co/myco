/**
 * myco_plans — list active implementation plans and their status.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlansInput {
  status?: string;
  limit?: number;
}

interface PlanSummary {
  id: string;
  title: string | null;
  status: string;
  progress: string;
  tags: string[];
  created_at: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoPlans(
  input: PlansInput,
  client: DaemonClient,
): Promise<PlanSummary[]> {
  const endpoint = buildEndpoint('/api/mcp/plans', {
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.plans) return [];

  return result.data.plans as PlanSummary[];
}
