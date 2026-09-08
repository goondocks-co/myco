/**
 * `myco_spores` over the Deployment's spores.
 *
 * Reads and writes go through `core/spores.ts`, the same functions the harness
 * routes use. A write carries the principal behind it (`writerOf`): a member's
 * spore the built-in `user` agent and the member as author, as it does in 1.4
 * plus the author; a run's its agent and the run as author. Every resolution is
 * one atomic write of the status and its event. The session a write names is
 * judged by `sessionOf`: a member's own machine's session, a run's
 * dispatch-named one.
 */
import { consolidateSpores, countSpores, getSpore, insertSpore, listSpores, listSupersededSporeIds, listSupersedingSporeIds, resolveSpore, type ResolutionAction, type SporeRow, type SporeStatus } from '../../core/spores.js';
import { mintSporeId, overSporeCap, planSporeConsolidation, planSporeResolution, SPORE_CAP_REASON, sporeTags } from '../../core/spore-writes.js';
import { latestPromptId } from '../../read/sessions.js';
import type { ReadScope } from '../../read/scope.js';
import { failure, scopeOf, sessionOf, writerOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const TOOL = 'myco_spores';

/** A spore as this principal reads it: the row entire for a member or a run; without `author` for an External Agent grant, which is told who wrote nothing. */
function visible(ctx: ToolContext, row: SporeRow): Record<string, unknown> {
  const shaped = snake<Record<string, unknown>>(row);
  if (ctx.principal.kind === 'grant') delete shaped.author;
  return shaped;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

async function resolve(ctx: ToolContext, scope: ReadScope, sporeId: string, status: SporeStatus, action: ResolutionAction, newSporeId: string | null, reason: string | null, sessionId: string | null): Promise<boolean> {
  const by = writerOf(ctx, TOOL);
  return resolveSpore(ctx.env.db, scope, status, {
    id: crypto.randomUUID(), agentId: by.agentId, author: by.author, sporeId, action, newSporeId, reason, sessionId, createdAt: ctx.now,
  }, ctx.now);
}

export async function handleSpores(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  const op = input.op ?? 'list';

  if (op === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const spore = await getSpore(db, scope, id);
    if (spore === null) return failure('Spore not found');
    const [supersededBy, predecessors] = await Promise.all([
      listSupersedingSporeIds(db, scope, id),
      listSupersededSporeIds(db, scope, id),
    ]);
    return { ...visible(ctx, spore), superseded_by: supersededBy, predecessors };
  }

  if (op === 'save') {
    const content = str(input.content);
    const type = str(input.type);
    if (content === undefined) return failure('content is required for op: save');
    if (type === undefined) return failure('type is required for op: save');
    if (overSporeCap(content)) return failure(SPORE_CAP_REASON);
    const by = writerOf(ctx, TOOL);
    const session = await sessionOf(ctx, scope, input, TOOL);
    if (!session.ok) return session;
    const promptId = session.sessionId === null ? null : await latestPromptId(db, scope, session.sessionId);
    const spore = await insertSpore(db, scope, {
      id: mintSporeId(type), agentId: by.agentId, sessionId: session.sessionId, promptId, observationType: type,
      content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null, author: by.author, createdAt: ctx.now,
    });
    if (spore === null) return failure('Spore was not recorded');
    return { id: spore.id, observation_type: spore.observationType, status: spore.status, created_at: spore.createdAt };
  }

  if (op === 'supersede') {
    const planned = await planSporeResolution(db, scope, {
      action: 'supersede', sporeId: str(input.old_spore_id), newSporeId: str(input.new_spore_id), reason: str(input.reason),
    });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const session = await sessionOf(ctx, scope, input, TOOL);
    if (!session.ok) return session;
    if (!(await resolve(ctx, scope, plan.sporeId, plan.status, 'supersede', plan.newSporeId, plan.reason, session.sessionId))) return failure('old_spore_id not found');
    return { old_spore: plan.sporeId, new_spore: plan.newSporeId, status: plan.status };
  }

  if (op === 'obsolete') {
    const planned = await planSporeResolution(db, scope, { action: 'obsolete', sporeId: str(input.id), reason: str(input.reason) });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const session = await sessionOf(ctx, scope, input, TOOL);
    if (!session.ok) return session;
    if (!(await resolve(ctx, scope, plan.sporeId, plan.status, 'obsolete', null, plan.reason, session.sessionId))) return failure('spore_id not found');
    return { spore: plan.sporeId, status: plan.status };
  }

  if (op === 'consolidate') {
    const planned = await planSporeConsolidation(db, scope, {
      sources: Array.isArray(input.source_spore_ids) ? input.source_spore_ids.map(String) : [],
      content: str(input.consolidated_content),
      observationType: str(input.observation_type),
      reason: str(input.reason),
    });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const by = writerOf(ctx, TOOL);
    const session = await sessionOf(ctx, scope, input, TOOL);
    if (!session.ok) return session;
    const promptId = session.sessionId === null ? null : await latestPromptId(db, scope, session.sessionId);
    const { wisdom, consolidated } = await consolidateSpores(db, scope, {
      id: mintSporeId(plan.observationType), agentId: by.agentId, sessionId: session.sessionId, promptId, observationType: plan.observationType,
      content: plan.content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null, author: by.author, createdAt: ctx.now,
    }, plan.sources, { agentId: by.agentId, author: by.author, reason: plan.reason, sessionId: session.sessionId, createdAt: ctx.now }, ctx.now);
    if (wisdom === null) return failure('Consolidated spore was not recorded');
    return { new_spore_id: wisdom.id, sources_consolidated: consolidated, status: 'consolidated', created_at: wisdom.createdAt };
  }

  const options = {
    agentId: str(input.agent_id),
    observationType: str(input.observation_type) ?? str(input.type),
    status: str(input.status) === 'all' ? undefined : str(input.status),
    search: str(input.search),
    limit: int(input.limit),
    offset: int(input.offset),
  };
  const [spores, total] = await Promise.all([listSpores(db, scope, options), countSpores(db, scope, options)]);
  return { spores: spores.map((s: SporeRow) => visible(ctx, s)), total, offset: options.offset ?? 0, limit: options.limit };
}
