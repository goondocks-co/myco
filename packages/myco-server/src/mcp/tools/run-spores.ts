/**
 * `myco_run_spores`: the inventory a run surveys by, and one body in full.
 *
 * The inventory carries previews rather than bodies, so the size of a Project
 * sets the cost of a pass over it rather than the size of its writing. Full
 * reads are counted and bounded per run, and one body arrives cut past its own
 * bound: a prompt asking for restraint is a request, and the surface holds the
 * run to it. Every bound comes off the run's window (`core/read-window.ts`),
 * so nothing here names a task.
 *
 * The count lives under the run's own key in agent state, moved by the same
 * guarded write every other state value is moved by, and is spent before the
 * row is fetched — a read of an id the Project does not hold still costs a unit.
 */
import {
  countSpores, getSpore, listSpores, listSupersededSporeIds, listSupersedingSporeIds,
  DEFAULT_SPORE_LIMIT, SPORE_STATUSES, type SporeRow,
} from '../../core/spores.js';
import { mutateState } from '../../core/runs.js';
import type { ReadWindow } from '../../core/read-window.js';
import { failure, runOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const MAX_SEARCH_CHARS = 1024;
const MAX_ID_CHARS = 192;

const str = (v: unknown, max: number): string | undefined =>
  (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/** One line, bounded: what a spore says, enough to group it with its neighbours. */
function preview(row: SporeRow, window: ReadWindow): Record<string, unknown> {
  return {
    id: row.id,
    observation_type: row.observationType,
    importance: row.importance,
    created_at: row.createdAt,
    preview: row.content.replace(/\s+/g, ' ').trim().slice(0, window.sporePreviewChars),
  };
}

/** Count one full read against this run's budget and answer the running total. */
async function spendFullRead(ctx: ToolContext, runId: string, agentId: string): Promise<number> {
  let spent = 0;
  await mutateState(ctx.env.db, { projectId: ctx.projectId }, agentId, `spore_reads:${runId}`, (current) => {
    const held = Number(current ?? 0);
    spent = (Number.isSafeInteger(held) && held > 0 ? held : 0) + 1;
    return String(spent);
  }, ctx.now);
  return spent;
}

export async function handleRunSpores(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_spores');
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const { window } = run;

  if (input.op === 'get') {
    const id = str(input.id, MAX_ID_CHARS);
    if (id === undefined) return failure('id is required for op: get');
    if ((await spendFullRead(ctx, run.runId, run.agentId)) > window.sporeFullReads) {
      return { spore: null, budget: 'spent' };
    }
    const spore = await getSpore(db, scope, id);
    if (spore === null) return failure('Spore not found');
    const [supersededBy, supersedes] = await Promise.all([
      listSupersedingSporeIds(db, scope, id),
      listSupersededSporeIds(db, scope, id),
    ]);
    const truncated = spore.content.length > window.sporeBodyChars;
    return {
      spore: snake(truncated ? { ...spore, content: spore.content.slice(0, window.sporeBodyChars) } : spore),
      truncated,
      superseded_by: supersededBy,
      supersedes,
    };
  }

  const asked = input.status === undefined ? 'active' : input.status;
  if (asked !== 'all' && !(SPORE_STATUSES as readonly unknown[]).includes(asked)) {
    return failure(`status is one of ${SPORE_STATUSES.join(', ')} or all`);
  }
  const options = {
    status: asked === 'all' ? undefined : asked as string,
    observationType: str(input.observation_type, MAX_ID_CHARS),
    search: str(input.search, MAX_SEARCH_CHARS),
    limit: Math.min(int(input.limit) ?? DEFAULT_SPORE_LIMIT, window.sporePage),
    offset: int(input.offset),
  };
  const [spores, total] = await Promise.all([listSpores(db, scope, options), countSpores(db, scope, options)]);
  return { spores: spores.map((row) => preview(row, window)), total };
}
