/**
 * myco_plans — list active implementation plans and their status.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

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
  const params = new URLSearchParams();
  if (input.status) params.set('status', input.status);
  if (input.limit) params.set('limit', String(input.limit));

  const qs = params.toString();
  const endpoint = qs ? `/api/mcp/plans?${qs}` : '/api/mcp/plans';
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.plans) return [];

  return result.data.plans as PlanSummary[];
}
