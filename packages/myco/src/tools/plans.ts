/**
 * myco_plans — list, retrieve, save, or delete implementation plans.
 *
 * `save`, `get`, `list` call the in-process services in `plans/save-mcp.ts`
 * and `plans/list-for-mcp.ts`. `delete` proxies through the daemon's
 * `/api/plans/:id` REST endpoint (the surface the daemon UI also consumes).
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { saveMcpPlan } from '@myco/plans/save-mcp.js';
import { listPlansForMcp } from '@myco/plans/list-for-mcp.js';
import { requestContextHeaders, resolveLegacyRequestContext, type MycoRequestContext } from './request-context.js';
import { extractErrorMessage, type ToolFailure } from './error.js';

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

export type PlanFailure = ToolFailure;

export type PlansResult = PlanSummary[] | PlanSummary | PlanDeleteResult | PlanSaveSuccess | PlanFailure;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoPlans(
  input: PlansInput,
  client: DaemonClient,
  contextOrVaultDir: MycoRequestContext | string,
): Promise<PlansResult> {
  const op = input.op ?? 'list';
  const context = typeof contextOrVaultDir === 'string'
    ? resolveLegacyRequestContext(contextOrVaultDir)
    : contextOrVaultDir;

  if (op === 'save') {
    if (!input.content) return { ok: false, error: 'content is required for op: save' };
    if (!input.id && !input.session_id) return { ok: false, error: 'session_id is required for op: save' };

    const result = saveMcpPlan({
      id: input.id,
      session_id: input.session_id,
      content: input.content,
      source_path: input.source_path,
      plan_key: input.plan_key,
      title: input.title,
      status: input.status,
      tags: input.tags,
      projectRoot: context.projectRoot,
      requestContext: context,
    });

    if (!result.ok) return { ok: false, error: result.message };

    const row = result.plan;
    return {
      ok: true,
      id: row.id,
      logical_key: row.logical_key,
      title: row.title,
      status: row.status,
      source_path: row.source_path,
      session_id: row.session_id,
      prompt_batch_id: row.prompt_batch_id,
      tags: row.tags ? row.tags.split(',').map((tag) => tag.trim()) : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  if (op === 'delete') {
    if (!input.id) {
      return { ok: false, error: 'id is required for op: delete' };
    }
    const body = input.force_remote ? { force_remote: true } : undefined;
    const result = await client.delete(
      `/api/plans/${encodeURIComponent(input.id)}`,
      body,
      { headers: requestContextHeaders(context) },
    );
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
    const result = listPlansForMcp({ id: input.id, requestContext: context });
    if (!result.ok) return { ok: false, error: result.message };
    if (!result.plans.length) return { ok: false, error: 'Plan not found' };
    return result.plans[0];
  }

  // op === 'list' (default)
  if (input.id && input.session) {
    return { ok: false, error: 'Pass either id or session, not both' };
  }

  const result = listPlansForMcp({
    session: input.session,
    status: input.status,
    limit: input.limit,
    requestContext: context,
  });
  if (!result.ok) return { ok: false, error: result.message };
  return result.plans;
}
