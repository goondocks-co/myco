import { countSpores, getSpore, listSpores, listSupersededSporeIds, listSupersedingSporeIds, type SporeRow } from '../../core/spores.js';
import { writeSpore } from '../../core/spore-admission.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';
import { learningMaterialUnread } from './run-learning.js';

function visible(row: SporeRow): Record<string, unknown> {
  return snake<Record<string, unknown>>(row);
}
const str = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const int = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;

export async function handleSpores(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const db = ctx.env.db;
  const op = input.op ?? 'list';
  if (['save', 'supersede', 'obsolete', 'consolidate'].includes(String(op))) {
    const unread = ctx.principal.kind === 'run' ? learningMaterialUnread(ctx.principal) : null;
    return unread ?? writeSpore(input, { ...ctx, projectId: scope.projectId });
  }
  if (op === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const spore = await getSpore(db, scope, id);
    if (spore === null) return failure('Spore not found');
    const [supersededBy, predecessors] = await Promise.all([
      listSupersedingSporeIds(db, scope, id),
      listSupersededSporeIds(db, scope, id),
    ]);
    return { ...visible(spore), superseded_by: supersededBy, predecessors };
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
  return { spores: spores.map((s: SporeRow) => visible(s)), total, offset: options.offset ?? 0, limit: options.limit };
}
