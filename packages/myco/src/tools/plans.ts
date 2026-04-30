/**
 * myco_plans — list, retrieve, save, or delete implementation plans.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 *
 * Ops:
 *   - list: list plans, filterable by status or session.
 *   - get: retrieve one plan by id.
 *   - save: persist a plan for a session.
 *   - delete: remove a plan; cross-machine rows require {force_remote: true}.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { extractErrorMessage } from './error.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlansInput {
  op?: 'list' | 'get' | 'save' | 'delete';
  id?: string;
  session?: string;
  session_id?: string;
  content?: string;
  source_path?: string;
  plan_key?: string;
  title?: string;
  status?: string;
  tags?: string[];
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

export interface PlanSaveSuccess {
  ok: true;
  id: string;
  logical_key: string;
  title: string | null;
  status: string;
  source_path: string | null;
  session_id: string | null;
  prompt_batch_id: number | null;
  tags: string[];
  created_at: number;
  updated_at: number | null;
}

export interface PlanFailure {
  ok: false;
  error: string;
}

/** Error shape returned from op: "list" when input validation fails
 *  (e.g. both `id` and `session` supplied). Matches the daemon's 400 body. */
export interface PlansListError {
  ok: false;
  error: string;
}

export type PlansResult = PlanSummary[] | PlanSummary | PlanDeleteResult | PlanSaveSuccess | PlanFailure | PlansListError;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoPlans(
  input: PlansInput,
  client: DaemonClient,
): Promise<PlansResult> {
  const op = input.op ?? 'list';

  if (op === 'save') {
    if (!input.session_id) return { ok: false, error: 'session_id is required for op: save' };
    if (!input.content) return { ok: false, error: 'content is required for op: save' };
    const result = await client.post('/api/mcp/plans', {
      session_id: input.session_id,
      content: input.content,
      source_path: input.source_path,
      plan_key: input.plan_key,
      title: input.title,
      status: input.status,
      tags: input.tags,
    });

    if (!result.ok || !result.data) {
      return { ok: false, error: extractErrorMessage(result.data, 'unknown') };
    }
    return { ok: true, ...(result.data as Omit<PlanSaveSuccess, 'ok'>) };
  }

  if (op === 'delete') {
    if (!input.id) {
      return { ok: false, error: 'id is required for op: delete' };
    }
    const body = input.force_remote ? { force_remote: true } : undefined;
    const result = await client.delete(`/api/plans/${encodeURIComponent(input.id)}`, body);
    if (!result.ok) {
      return { ok: false, error: extractErrorMessage(result.data, 'delete_failed') };
    }
    return {
      ok: Boolean(result.data?.ok),
      id: result.data?.id,
      session_id: result.data?.session_id ?? null,
    };
  }

  if (op === 'get') {
    if (!input.id) return { ok: false, error: 'id is required for op: get' };
    const endpoint = buildEndpoint('/api/mcp/plans', { id: input.id });
    const result = await client.get(endpoint);
    const plans = result.data?.plans as PlanSummary[] | undefined;
    if (!result.ok || !plans?.length) return { ok: false, error: 'Plan not found' };
    return plans[0];
  }

  // op === 'list' (default)
  if (input.id && input.session) {
    // Match the daemon's /api/mcp/plans 400 behavior — surface the rejection
    // as a structured error instead of silently returning [].
    return { ok: false, error: 'Pass either id or session, not both' };
  }

  const endpoint = buildEndpoint('/api/mcp/plans', {
    session: input.session,
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.plans) return [];

  return result.data.plans as PlanSummary[];
}
