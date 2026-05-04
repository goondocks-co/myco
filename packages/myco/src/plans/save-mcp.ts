/**
 * Save a plan from the MCP write path. Wraps `persistPlan` with the session
 * validation and logical-key construction that the MCP shape requires.
 * Callable from any process with the vault DB initialized.
 */

import { getLatestOpenBatch } from '@myco/db/queries/batches.js';
import { getSession } from '@myco/db/queries/sessions.js';
import {
  buildPathPlanLogicalKey,
  buildSessionPlanLogicalKey,
  normalizePlanSourcePath,
} from '@myco/plans/identity.js';
import { persistPlan } from '../daemon/plan-capture.js';
import type { PlanRow } from '@myco/db/queries/plans.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

export interface SaveMcpPlanInput {
  session_id: string;
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
  | { ok: false; code: 'invalid-arguments'; message: string };

export function saveMcpPlan(input: SaveMcpPlanInput): SaveMcpPlanResult {
  const hasSourcePath = Boolean(input.source_path);
  const hasPlanKey = Boolean(input.plan_key);
  if (hasSourcePath === hasPlanKey) {
    return {
      ok: false,
      code: 'invalid-arguments',
      message: 'Provide exactly one of source_path or plan_key',
    };
  }

  const session = getSession(input.session_id);
  if (!session) {
    return { ok: false, code: 'session-not-found', message: 'Session not found' };
  }

  const openBatch = getLatestOpenBatch(input.session_id);
  const normalizedSourcePath = input.source_path
    ? normalizePlanSourcePath(input.source_path, input.projectRoot)
    : null;
  const logicalKey = normalizedSourcePath
    ? buildPathPlanLogicalKey(normalizedSourcePath)
    : buildSessionPlanLogicalKey(input.session_id, input.plan_key!);

  const plan = persistPlan({
    sessionId: input.session_id,
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
