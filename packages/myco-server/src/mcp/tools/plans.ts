/**
 * `myco_plans` over the Deployment's plans.
 *
 * A save is a `plan` capture event through the same ingest path a member hook
 * uses, so a plan named by its file lands on the row the hook would write —
 * the key is the member's own derivation. A status-only update re-reads the
 * row and re-emits it whole: the kind carries the plan entire, never a delta.
 * Plans are Project-shared editorial rows: any member may update one, and the
 * credential that did is recorded on it. Every save names the caller's own
 * session — the one its hooks capture on this machine — never the row's: a
 * session belongs to the machine that captured it, and an event naming
 * another machine's session is refused as capture into it would be.
 *
 * Deleting is not served: a Deployment keeps every plan; `abandoned` is the
 * status for one that no longer applies.
 */
import { SERVER_PROTOCOL } from '../../constants.js';
import { utf8, uuidv5 } from '../../hash.js';
import { ingestEvent } from '../../ingest/events.js';
import { getPlan, listProjectPlans, type ProjectPlanRow } from '../../read/plans.js';
import type { ReadScope } from '../../read/scope.js';
import { failure, memberOf, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

/** What the `plan` events this tool emits say produced them. */
export const MCP_PRODUCER = { adapter: 'mcp', version: String(SERVER_PROTOCOL) } as const;

export interface PlanSummary {
  id: string;
  title: string | null;
  status: string;
  progress: string;
  tags: string[];
  created_at: number;
  content?: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** The statuses a save may write; the list filter alone admits 'all'. */
const WRITABLE_PLAN_STATUSES = new Set(['active', 'in_progress', 'completed', 'abandoned']);

/** `checked/total` over the plan's task list, or `N/A` when it has none. */
export function progressOf(content: string | null): string {
  const text = content ?? '';
  const checked = (text.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (text.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

function summary(row: ProjectPlanRow): PlanSummary {
  return { id: row.planKey, title: row.title, status: row.status, progress: progressOf(row.content), tags: row.tags, created_at: row.createdAt };
}

/** The plan's text: the row's, or the spilled blob's. */
async function contentOf(ctx: ToolContext, scope: ReadScope, row: ProjectPlanRow): Promise<string | null> {
  if (row.content !== null || row.blobKey === null) return row.content;
  const object = await ctx.env.blobs.get(`${scope.projectId}/${row.blobKey}`);
  return object === null ? null : new Response(object.body).text();
}

/** The key a plan is stored under: the id given, the member's derivation for a file, or a derivation of the logical key. */
export async function planKeyFor(projectId: string, input: { id?: string; source_path?: string; plan_key?: string }): Promise<string | null> {
  if (input.id !== undefined) return input.id;
  if (input.source_path !== undefined) return uuidv5('plan', projectId, input.source_path);
  if (input.plan_key !== undefined) return uuidv5('plan-key', projectId, input.plan_key);
  return null;
}

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
    return { ...summary(row), content: await contentOf(ctx, scope, row) };
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
  if (status !== undefined && !WRITABLE_PLAN_STATUSES.has(status)) return failure('status must be one of: active, in_progress, completed, abandoned');
  if (input.source_path !== undefined && input.plan_key !== undefined) return failure('Pass either source_path or plan_key, not both');

  const planKey = await planKeyFor(scope.projectId, { id, source_path: str(input.source_path), plan_key: str(input.plan_key) });
  if (planKey === null) return failure('source_path or plan_key is required when creating a new plan');
  const existing = await getPlan(ctx.env.db, scope, planKey);
  if (id !== undefined && existing === null) return failure('Plan not found');

  const text = content ?? existing?.content ?? null;
  const blob = text === null ? existing?.blobKey ?? null : null;
  if (text === null && blob === null) return failure('content is required when creating a new plan');
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : existing?.tags ?? [];
  const payload: Record<string, unknown> = {
    planKey,
    title: str(input.title) ?? existing?.title ?? undefined,
    status: status ?? existing?.status ?? 'active',
    originPath: str(input.source_path) ?? existing?.originPath ?? undefined,
    tags,
    ...(text === null ? { blob } : { content: text }),
  };
  const envelope = {
    eventId: crypto.randomUUID(),
    sessionId,
    kind: 'plan',
    createdAt: ctx.now,
    channel: 'http',
    producer: MCP_PRODUCER,
    payload,
  };
  const bodyBytes = utf8(JSON.stringify(payload)).byteLength;
  const member = memberOf(ctx, 'myco_plans');
  const result = await ingestEvent(ctx.env.db, { projectId: scope.projectId, machineId: member.machineId, tokenId: member.tokenId, bodyBytes, now: ctx.now }, envelope);
  if (!result.persisted || result.projected === false) return { ok: false, code: result.code, error: result.reason };

  const row = await getPlan(ctx.env.db, scope, planKey);
  if (row === null) return failure('Plan was not recorded');
  const logicalKey = input.source_path !== undefined ? `path:${String(input.source_path)}` : input.plan_key !== undefined ? `session:${row.sessionId}:key:${String(input.plan_key)}` : planKey;
  return {
    ok: true,
    id: row.planKey,
    logical_key: logicalKey,
    title: row.title,
    status: row.status,
    source_path: row.originPath,
    session_id: row.sessionId,
    prompt_batch_id: null,
    tags: row.tags,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
