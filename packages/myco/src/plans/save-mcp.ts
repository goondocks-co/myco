/**
 * Save a plan from the MCP write path. Wraps `persistPlan` with the session
 * validation and logical-key construction that the MCP shape requires.
 * Callable from any process with the vault DB initialized.
 */

import { getLatestOpenBatch } from '@myco/db/queries/batches.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { getPlan } from '@myco/db/queries/plans.js';
import {
  buildPathPlanLogicalKey,
  buildSessionPlanLogicalKey,
  normalizePlanSourcePath,
} from '@myco/plans/identity.js';
import { persistPlan } from '../daemon/plan-capture.js';
import type { PlanRow } from '@myco/db/queries/plans.js';
import {
  rowProjectIdFromRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';

export interface SaveMcpPlanInput {
  id?: string;
  session_id?: string;
  content: string;
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
    const existingPlan = getPlan(input.id, projectId);
    if (!existingPlan) {
      return { ok: false, code: 'plan-not-found', message: 'Plan not found' };
    }
    if (input.session_id && !getSession(input.session_id, projectId)) {
      return { ok: false, code: 'session-not-found', message: 'Session not found' };
    }
    const openBatch = input.session_id ? getLatestOpenBatch(input.session_id) : null;
    const plan = persistPlan({
      id: existingPlan.id,
      sessionId: input.session_id || existingPlan.session_id,
      projectId,
      content: input.content,
      logicalKey: existingPlan.logical_key,
      sourcePath: existingPlan.source_path,
      promptBatchId: openBatch?.id ?? existingPlan.prompt_batch_id,
      title: input.title,
      status: input.status,
      tags: input.tags,
    });
    return { ok: true, plan };
  }

  if (hasSourcePath === hasPlanKey) {
    return {
      ok: false,
      code: 'invalid-arguments',
      message: 'Provide exactly one of source_path or plan_key',
    };
  }

  const sessionId = input.session_id!;
  const session = getSession(sessionId, projectId);
  if (!session) {
    return { ok: false, code: 'session-not-found', message: 'Session not found' };
  }

  const openBatch = getLatestOpenBatch(sessionId);
  const normalizedSourcePath = input.source_path
    ? normalizePlanSourcePath(input.source_path, input.projectRoot)
    : null;
  const logicalKey = normalizedSourcePath
    ? buildPathPlanLogicalKey(normalizedSourcePath)
    : buildSessionPlanLogicalKey(sessionId, input.plan_key!);

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
