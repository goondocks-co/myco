/**
 * `myco_plans` over the Deployment's plans: the tool face of `core/plans.ts`.
 * A save that carries content, title or tags names the caller's own session —
 * the one its hooks capture on this machine — never the row's: a session
 * belongs to the machine that captured it, and an event naming another
 * machine's session is refused as capture into it would be. A status-only
 * save is a shared editorial edit by the caller's member, the same write the
 * dashboard makes; it names the session for the record and writes the row.
 */
import { changePlanStatus, savePlan } from '../../core/plans.js';
import { getPlan, listProjectPlans, PLAN_STATUS_MESSAGE, WRITABLE_PLAN_STATUSES, type ProjectPlanRow } from '../../read/plans.js';
import type { ReadScope } from '../../read/scope.js';
import { processedBody } from '../../read/processed.js';
import { failure, memberOf, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';


export interface PlanSummary {
  id: string;
  title: string | null;
  status: string;
  progress: string;
  prompt_id: string | null;
  tags: string[];
  created_at: number;
  content?: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export const isPlanStatusOnly = (input: ToolInput): input is ToolInput & { id: string; status: string } => str(input.id) !== undefined && str(input.status) !== undefined
  && str(input.content) === undefined && str(input.title) === undefined && !Array.isArray(input.tags);

function summary(row: ProjectPlanRow): PlanSummary {
  return { id: row.planKey, title: row.title, status: row.status, progress: row.progress, prompt_id: row.promptId, tags: row.tags, created_at: row.createdAt };
}

const saved = (row: ProjectPlanRow, logicalKey: string) => ({
  ok: true,
  id: row.planKey,
  logical_key: logicalKey,
  title: row.title,
  status: row.status,
  source_path: row.originPath,
  session_id: row.sessionId,
  prompt_id: row.promptId,
  updated_by: row.updatedBy,
  tags: row.tags,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

export async function handlePlans(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  const op = input.op ?? 'list';

  if (op === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const row = await getPlan(db, scope, id);
    if (row === null) return failure('Plan not found');
    return { ...summary(row), content: await processedBody(ctx.env, scope, 'plan', row.planKey) };
  }

  if (op === 'save') return save(input, ctx, scope);

  if (input.id !== undefined && input.session !== undefined) return failure('Pass either id or session, not both');
  const status = str(input.status);
  const rows = await listProjectPlans(db, scope, {
    status: status === undefined || status === 'all' ? undefined : status,
    sessionId: str(input.session),
    limit: typeof input.limit === 'number' ? input.limit : undefined,
  });
  return rows.map(summary);
}

async function save(input: ToolInput, ctx: ToolContext, scope: ReadScope): Promise<unknown> {
  const id = str(input.id);
  const content = str(input.content);
  const sessionId = str(input.session_id);
  if (content === undefined && id === undefined) return failure('content is required when creating a new plan');
  if (sessionId === undefined) return failure('session_id is required for op: save');
  const status = str(input.status);
  if (status !== undefined && !WRITABLE_PLAN_STATUSES.has(status)) return failure(PLAN_STATUS_MESSAGE);
  const member = memberOf(ctx, 'myco_plans');
  const title = str(input.title);
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : undefined;

  if (isPlanStatusOnly(input)) {
    const existing = await getPlan(ctx.env.db, scope, input.id);
    if (existing === null) return failure('Plan not found');
    const row = await changePlanStatus(ctx.env.db, scope, input.id, input.status, member.memberId, ctx.now);
    if (row === null) return failure('Plan not found');
    return saved(row, input.id);
  }

  const outcome = await savePlan(ctx.env, member, scope, {
    id, sessionId, content, title, status, tags,
    sourcePath: str(input.source_path), planKey: str(input.plan_key), promptId: str(input.prompt_id),
  }, ctx.now);
  if (!outcome.ok) return outcome.code === undefined ? failure(outcome.error) : { ok: false, code: outcome.code, error: outcome.error };
  return saved(outcome.row, outcome.logicalKey);
}
