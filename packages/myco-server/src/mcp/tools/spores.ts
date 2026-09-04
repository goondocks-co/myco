/**
 * `myco_spores` over the Deployment's spores.
 *
 * Reads and writes go through `core/spores.ts`, the same functions the harness
 * routes use. A spore a member records carries the built-in `user` agent, as it
 * does in 1.4. Every resolution is one atomic write of the status and its event.
 *
 * **A named session is one the caller's own machine holds.** The agent echoes
 * the id the prompt hook injected, and the tool admits it only when the
 * addressed Project holds that session under the machine behind the credential.
 * Every other case answers one refusal, so an id that is not the caller's tells
 * the caller nothing about whether the Deployment holds it.
 */
import { consolidateSpores, countSpores, getSpore, insertSpore, listSpores, listSupersededSporeIds, listSupersedingSporeIds, resolveSpore, type ResolutionAction, type SporeRow, type SporeStatus } from '../../core/spores.js';
import { mintSporeId, overSporeCap, planSporeConsolidation, planSporeResolution, SPORE_CAP_REASON, sporeTags } from '../../core/spore-writes.js';
import { latestPromptId, sessionHeldByMachine } from '../../read/sessions.js';
import type { ReadScope } from '../../read/scope.js';
import { failure, memberOf, scopeOf, type ToolContext, type ToolFailure } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

/** The agent every member-recorded spore carries; seeded by the schema. */
export const USER_AGENT_ID = 'user';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

async function resolve(ctx: ToolContext, scope: ReadScope, sporeId: string, status: SporeStatus, action: ResolutionAction, newSporeId: string | null, reason: string | null, sessionId: string | null): Promise<boolean> {
  return resolveSpore(ctx.env.db, scope, status, {
    id: crypto.randomUUID(), agentId: USER_AGENT_ID, sporeId, action, newSporeId, reason, sessionId, createdAt: ctx.now,
  }, ctx.now);
}

/** The one refusal for a `session_id` this caller may not name, whatever the cause. */
const SESSION_NOT_FOUND = 'session_id not found';

/** The session a write names, or null when it names none; the refusal when the addressed Project holds no such session of the caller's machine. */
async function namedSession(ctx: ToolContext, scope: ReadScope, input: ToolInput): Promise<{ ok: true; sessionId: string | null } | ToolFailure> {
  const sessionId = str(input.session_id);
  if (sessionId === undefined) return { ok: true, sessionId: null };
  const { machineId } = memberOf(ctx, 'myco_spores');
  if (!(await sessionHeldByMachine(ctx.env.db, scope, sessionId, machineId))) return failure(SESSION_NOT_FOUND);
  return { ok: true, sessionId };
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
    return { ...snake<Record<string, unknown>>(spore), superseded_by: supersededBy, predecessors };
  }

  if (op === 'save') {
    const content = str(input.content);
    const type = str(input.type);
    if (content === undefined) return failure('content is required for op: save');
    if (type === undefined) return failure('type is required for op: save');
    if (overSporeCap(content)) return failure(SPORE_CAP_REASON);
    const session = await namedSession(ctx, scope, input);
    if (!session.ok) return session;
    const promptId = session.sessionId === null ? null : await latestPromptId(db, scope, session.sessionId);
    const spore = await insertSpore(db, scope, {
      id: mintSporeId(type), agentId: USER_AGENT_ID, sessionId: session.sessionId, promptId, observationType: type,
      content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null, createdAt: ctx.now,
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
    const session = await namedSession(ctx, scope, input);
    if (!session.ok) return session;
    if (!(await resolve(ctx, scope, plan.sporeId, plan.status, 'supersede', plan.newSporeId, plan.reason, session.sessionId))) return failure('old_spore_id not found');
    return { old_spore: plan.sporeId, new_spore: plan.newSporeId, status: plan.status };
  }

  if (op === 'obsolete') {
    const planned = await planSporeResolution(db, scope, { action: 'obsolete', sporeId: str(input.id), reason: str(input.reason) });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const session = await namedSession(ctx, scope, input);
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
    const session = await namedSession(ctx, scope, input);
    if (!session.ok) return session;
    const promptId = session.sessionId === null ? null : await latestPromptId(db, scope, session.sessionId);
    const { wisdom, consolidated } = await consolidateSpores(db, scope, {
      id: mintSporeId(plan.observationType), agentId: USER_AGENT_ID, sessionId: session.sessionId, promptId, observationType: plan.observationType,
      content: plan.content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null, createdAt: ctx.now,
    }, plan.sources, { agentId: USER_AGENT_ID, reason: plan.reason, sessionId: session.sessionId, createdAt: ctx.now }, ctx.now);
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
  return { spores: spores.map((s: SporeRow) => snake(s)), total, offset: options.offset ?? 0, limit: options.limit };
}
