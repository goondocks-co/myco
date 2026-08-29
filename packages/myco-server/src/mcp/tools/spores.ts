/**
 * `myco_spores` over the Deployment's spores.
 *
 * Reads and writes go through `core/spores.ts`, the same functions the harness
 * routes use. A spore a member records carries the built-in `user` agent, as it
 * does in 1.4, and no session: the bridge that relays the call knows none.
 * Every resolution is one atomic write of the status and its event.
 */
import { countSpores, getSpore, insertSpore, listSpores, listSupersedingSporeIds, resolveSpore, type SporeRow } from '../../core/spores.js';
import type { ReadScope } from '../../read/scope.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

/** The agent every member-recorded spore carries; seeded by the schema. */
export const USER_AGENT_ID = 'user';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
const tagsOf = (v: unknown): string | null => (Array.isArray(v) && v.length > 0 ? v.map(String).join(', ') : null);

/** `<type>-<8 hex>`, the id shape 1.4 gives a recorded spore. */
function sporeId(type: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${type}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function resolve(ctx: ToolContext, scope: ReadScope, sporeId: string, status: 'superseded' | 'consolidated' | 'obsolete', action: 'supersede' | 'consolidate' | 'obsolete', newSporeId: string | null, reason: string | null): Promise<boolean> {
  return resolveSpore(ctx.env.db, scope, status, {
    id: crypto.randomUUID(), agentId: USER_AGENT_ID, sporeId, action, newSporeId, reason, sessionId: null, createdAt: ctx.now,
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
    return { ...snake<Record<string, unknown>>(spore), superseded_by: await listSupersedingSporeIds(db, scope, id) };
  }

  if (op === 'save') {
    const content = str(input.content);
    const type = str(input.type);
    if (content === undefined) return failure('content is required for op: save');
    if (type === undefined) return failure('type is required for op: save');
    const spore = await insertSpore(db, scope, {
      id: sporeId(type), agentId: USER_AGENT_ID, sessionId: null, promptId: null, observationType: type,
      content, context: null, filePath: null, tags: tagsOf(input.tags), contentHash: null, properties: null, createdAt: ctx.now,
    });
    if (spore === null) return failure('Spore was not recorded');
    return { id: spore.id, observation_type: spore.observationType, status: spore.status, created_at: spore.createdAt };
  }

  if (op === 'supersede') {
    const oldId = str(input.old_spore_id);
    const newId = str(input.new_spore_id);
    if (oldId === undefined) return failure('old_spore_id is required for op: supersede');
    if (newId === undefined) return failure('new_spore_id is required for op: supersede');
    if ((await getSpore(db, scope, oldId)) === null) return failure('old_spore_id not found');
    if ((await getSpore(db, scope, newId)) === null) return failure('new_spore_id not found');
    if (!(await resolve(ctx, scope, oldId, 'superseded', 'supersede', newId, str(input.reason) ?? null))) return failure('old_spore_id not found');
    return { old_spore: oldId, new_spore: newId, status: 'superseded' };
  }

  if (op === 'obsolete') {
    const id = str(input.id);
    const reason = str(input.reason);
    if (id === undefined) return failure('id is required for op: obsolete');
    if (reason === undefined) return failure('reason is required for op: obsolete');
    if (!(await resolve(ctx, scope, id, 'obsolete', 'obsolete', null, reason))) return failure('spore_id not found');
    return { spore: id, status: 'obsolete' };
  }

  if (op === 'consolidate') {
    const sources = Array.isArray(input.source_spore_ids) ? input.source_spore_ids.map(String) : [];
    const content = str(input.consolidated_content);
    const type = str(input.observation_type);
    if (sources.length === 0) return failure('source_spore_ids is required for op: consolidate');
    if (content === undefined) return failure('consolidated_content is required for op: consolidate');
    if (type === undefined) return failure('observation_type is required for op: consolidate');
    for (const id of sources) if ((await getSpore(db, scope, id)) === null) return failure(`source_spore_id not found: ${id}`);
    const wisdom = await insertSpore(db, scope, {
      id: sporeId(type), agentId: USER_AGENT_ID, sessionId: null, promptId: null, observationType: type,
      content, context: null, filePath: null, tags: tagsOf(input.tags), contentHash: null, properties: null, createdAt: ctx.now,
    });
    if (wisdom === null) return failure('Consolidated spore was not recorded');
    const reason = str(input.reason) ?? null;
    let consolidated = 0;
    for (const id of sources) if (await resolve(ctx, scope, id, 'consolidated', 'consolidate', wisdom.id, reason)) consolidated += 1;
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
