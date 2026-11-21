import { latestSporeResolution } from '../../db/spores/resolutions.js';
import { listSporeOriginPage, listSporePage, type SporeRow } from '../../core/spores.js';
import { MAX_MIN_SOURCES } from '../../db/spores/origins.js';
import { getSpore } from '../../db/spores/records.js';
import { listSupersededSporeIds, listSupersedingSporeIds } from '../../db/spores/edges.js';
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
    const [supersededBy, predecessors, resolution] = await Promise.all([
      listSupersedingSporeIds(db, scope, id),
      listSupersededSporeIds(db, scope, id),
      latestSporeResolution(db,scope,id),
    ]);
    return { ...visible(spore), superseded_by: supersededBy, predecessors, resolution: resolution===null?null:snake(resolution) };
  }

  if (input.origin !== undefined || input.min_sources !== undefined) return listByOrigin(input, ctx, scope);
  const options = {
    agentId: str(input.agent_id),
    observationType: str(input.observation_type) ?? str(input.type),
    status: str(input.status) === 'all' ? undefined : str(input.status),
    limit: int(input.limit),
    cursor: str(input.cursor),
  };
  const listed = await listSporePage(db, scope, options);
  if (listed === null) return failure(`Not read: cursor ${JSON.stringify(input.cursor)} is not one this list answered. Next call: myco_spores ${JSON.stringify({ op: 'list', ...(options.status === undefined ? {} : { status: options.status }) })} to start from the first page.`);
  return {
    spores: listed.rows.map((s: SporeRow) => visible(s)),
    has_more: listed.hasMore,
    cursor: listed.cursor,
    ...(listed.total === undefined ? {} : { total: listed.total }),
    ...(listed.counting === undefined ? {} : { counting: listed.counting }),
  };
}

/** A list narrowed by how its spores came to be: by origin and source count, with status and type, and its total. */
async function listByOrigin(input: ToolInput, ctx: ToolContext, scope: { projectId: string }): Promise<unknown> {
  const origin = input.origin === 'saved' ? 'saved' as const : input.origin === 'curated' ? 'curated' as const : undefined;
  const minSources = input.min_sources;
  const status = str(input.status) === 'all' ? undefined : str(input.status);
  const observationType = str(input.observation_type) ?? str(input.type);
  const call = (args: Record<string, unknown>) => `myco_spores ${JSON.stringify({ op: 'list', ...args })}`;
  const asked = { ...(origin === undefined ? {} : { origin }), ...(minSources === undefined ? {} : { min_sources: minSources }),
    ...(input.status === undefined ? {} : { status: input.status }), ...(observationType === undefined ? {} : { observation_type: observationType }) };
  if (minSources !== undefined && (typeof minSources !== 'number' || !Number.isSafeInteger(minSources) || minSources < 1 || minSources > MAX_MIN_SOURCES))
    return failure(`Not listed: min_sources is ${JSON.stringify(minSources)}; it must be 1 or ${MAX_MIN_SOURCES} (${MAX_MIN_SOURCES} lists spores written from more than one). Next call: ${call({ ...asked, min_sources: MAX_MIN_SOURCES })}`);
  if (origin === 'saved' && minSources !== undefined)
    return failure(`Not listed: origin "saved" names spores written from no others, so min_sources ${minSources} matches none. Next call: ${call({ ...asked, origin: 'curated' })}`);
  if (input.agent_id !== undefined)
    return failure(`Not listed: origin and min_sources combine with status and observation_type, not agent_id ${JSON.stringify(input.agent_id)}. Next call: ${call(asked)}`);
  const listed = await listSporeOriginPage(ctx.env.db, scope, { origin, minSources: minSources as number | undefined, status, observationType, limit: int(input.limit), cursor: str(input.cursor) });
  if (listed === null) return failure(`Not read: cursor ${JSON.stringify(input.cursor)} is not one this list answered. Next call: ${call(asked)} to start from the first page.`);
  if ('building' in listed)
    return { ...failure(`Not listed yet: Myco is still working out how existing spores came to be. Next call: ${call(asked)} again after a minute.`), counting: 'building' };
  return { spores: listed.rows.map((s: SporeRow) => visible(s)), has_more: listed.hasMore, cursor: listed.cursor, total: listed.total };
}
