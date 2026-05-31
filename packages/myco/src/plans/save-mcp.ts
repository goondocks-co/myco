/**
 * Save a plan from the MCP write path. Wraps `persistPlan` with the session
 * validation and logical-key construction that the MCP shape requires.
 * Callable from any process with the vault DB initialized.
 */

import { getLatestOpenBatch } from '@myco/db/queries/batches.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { getPlan } from '@myco/db/queries/plans.js';
import {
  resolvePlanLogicalKey,
  normalizePlanSourcePath,
} from '@myco/plans/identity.js';
import { persistPlan } from '../daemon/plan-capture.js';
import type { PlanRow } from '@myco/db/queries/plans.js';
import {
  projectScopeFromRequestContext,
  rowProjectIdFromRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';

export interface SaveMcpPlanInput {
  id?: string;
  session_id?: string;
  /** Required for new plans; optional when `id` is set — omitted content preserves the existing body. */
  content?: string;
  source_path?: string;
  plan_key?: string;
  title?: string;
  status?: string;
  tags?: string[];
  /** Project root used to canonicalize relative-vs-absolute file paths. */
  projectRoot: string;
  requestContext?: MycoRequestContext;
}

export type SaveMcpPlanResult =
  | { ok: true; plan: PlanRow }
  | { ok: false; code: 'session-not-found'; message: string }
  | { ok: false; code: 'plan-not-found'; message: string }
  | { ok: false; code: 'invalid-arguments'; message: string };

export function saveMcpPlan(input: SaveMcpPlanInput): SaveMcpPlanResult {
  const projectId = rowProjectIdFromRequestContext(input.requestContext);
  const scope = projectScopeFromRequestContext(input.requestContext);
  const hasSourcePath = Boolean(input.source_path);
  const hasPlanKey = Boolean(input.plan_key);
  if (input.id) {
    if (hasSourcePath || hasPlanKey) {
      return {
        ok: false,
        code: 'invalid-arguments',
        message: 'Pass id without source_path or plan_key when updating an existing plan',
      };
    }
    const existingPlan = getPlan(input.id, scope);
    if (!existingPlan) {
      return { ok: false, code: 'plan-not-found', message: 'Plan not found' };
    }
    if (input.session_id && !getSession(input.session_id, scope)) {
      return { ok: false, code: 'session-not-found', message: 'Session not found' };
    }
    const openBatch = input.session_id ? getLatestOpenBatch(input.session_id) : null;
    const plan = persistPlan({
      id: existingPlan.id,
      // The creating session is set once, then immutable. A real creator is
      // never re-homed onto a later caller — that cross-session update is
      // recorded as lineage (PLAN_ADVANCED) instead. A legacy plan with no
      // creator adopts the first updating session.
      sessionId: existingPlan.session_id ?? input.session_id,
      projectId,
      // Omitting content on update preserves the existing body — the common
      // case for status-only transitions (active → in_progress → completed).
      // PlanRow.content is nullable at the DB layer; empty string is the safe
      // fallback for that edge case (plans historically always have content).
      content: input.content ?? existingPlan.content ?? '',
      logicalKey: existingPlan.logical_key,
      sourcePath: existingPlan.source_path,
      promptBatchId: openBatch?.id ?? existingPlan.prompt_batch_id,
      title: input.title,
      status: input.status,
      tags: input.tags,
    });
    return { ok: true, plan };
  }

  if (!input.content) {
    return {
      ok: false,
      code: 'invalid-arguments',
      message: 'content is required when creating a new plan',
    };
  }

  if (!hasSourcePath && !hasPlanKey) {
    return {
      ok: false,
      code: 'invalid-arguments',
      message: 'Provide source_path, plan_key, or both when creating a new plan',
    };
  }

  const sessionId = input.session_id!;
  const session = getSession(sessionId, scope);
  if (!session) {
    return { ok: false, code: 'session-not-found', message: 'Session not found' };
  }

  const openBatch = getLatestOpenBatch(sessionId);
  const normalizedSourcePath = input.source_path
    ? normalizePlanSourcePath(input.source_path, input.projectRoot)
    : null;
  const logicalKey = resolvePlanLogicalKey(sessionId, {
    planKey: input.plan_key,
    normalizedSourcePath,
  });

  const plan = persistPlan({
    sessionId,
    projectId,
    content: input.content,
    logicalKey,
    sourcePath: normalizedSourcePath,
    promptBatchId: openBatch?.id,
    title: input.title,
    status: input.status,
    tags: input.tags,
    planKey: input.plan_key ?? null,
  });

  return { ok: true, plan };
}
