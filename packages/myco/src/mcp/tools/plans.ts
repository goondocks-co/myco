/**
 * myco_plans — list active implementation plans or delete one.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 *
 * Ops:
 *   - list: list plans, filterable by status, session, or a single id.
 *   - delete: remove a plan; cross-machine rows require {force_remote: true}.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlansInput {
  op?: 'list' | 'delete';
  id?: string;
  session?: string;
  status?: string;
  limit?: number;
  force_remote?: boolean;
}

export interface PlanSummary {
  id: string;
  title: string | null;
  status: string;
  progress: string;
  tags: string[];
  created_at: number;
  /** Full plan content — present only when looked up by id. */
  content?: string | null;
}

export interface PlanDeleteResult {
  ok: boolean;
  id?: string;
  session_id?: string | null;
  error?: string;
}

/** Error shape returned from op: "list" when input validation fails
 *  (e.g. both `id` and `session` supplied). Matches the daemon's 400 body. */
export interface PlansListError {
  ok: false;
  error: string;
}

export type PlansResult = PlanSummary[] | PlanDeleteResult | PlansListError;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoPlans(
  input: PlansInput,
  client: DaemonClient,
): Promise<PlansResult> {
  const op = input.op ?? 'list';

  if (op === 'delete') {
    if (!input.id) {
      return { ok: false, error: 'id is required for op: delete' };
    }
    const body = input.force_remote ? { force_remote: true } : undefined;
    const result = await client.delete(`/api/plans/${encodeURIComponent(input.id)}`, body);
    if (!result.ok) {
      return {
        ok: false,
        error: result.data?.error ?? 'delete_failed',
      };
    }
    return {
      ok: Boolean(result.data?.ok),
      id: result.data?.id,
      session_id: result.data?.session_id ?? null,
    };
  }

  // op === 'list' (default)
  if (input.id && input.session) {
    // Match the daemon's /api/mcp/plans 400 behavior — surface the rejection
    // as a structured error instead of silently returning [].
    return { ok: false, error: 'Pass either id or session, not both' };
  }

  const endpoint = buildEndpoint('/api/mcp/plans', {
    id: input.id,
    session: input.session,
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.plans) return [];

  return result.data.plans as PlanSummary[];
}
