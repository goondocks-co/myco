import { RUN_SPORE_ID_MAX_CHARS as MAX_ID_CHARS, RUN_SPORE_CURSOR_MAX_CHARS as MAX_CURSOR_CHARS } from '../../core/run-tool-contract.js';
import { runRefusal } from '../../core/run-tool-contract.js';
import { SPORE_READ_STATE_PREFIX } from '../../constants.js';
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
import { listSporePage, DEFAULT_SPORE_LIMIT, SPORE_STATUSES, type SporeRow } from '../../core/spores.js';
import { getSpore } from '../../db/spores/records.js';
import { listSupersededSporeIds, listSupersedingSporeIds } from '../../db/spores/edges.js';
import { mutateState } from '../../db/runs/state.js';
import { RUN_ANSWER_BYTES, type ReadWindow } from '../../core/read-window.js';
import { answerBytes } from '../../core/material-pages.js';
import { runOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/** One line, bounded: what a spore says, enough to group it with its neighbours. */
function preview(row: SporeRow, window: ReadWindow): Record<string, unknown> {
  return {
    id: row.id,
    revision: row.revision,
    observation_type: row.observationType,
    importance: row.importance,
    created_at: row.createdAt,
    preview: row.content.replace(/\s+/g, ' ').trim().slice(0, window.sporePreviewChars),
  };
}

/** One spore cut to `chars` of each long field, and further where that still weighs past one answer, so a get always answers. */
function fullRead(spore: SporeRow, chars: number, around: { superseded_by: string[]; supersedes: string[] }): Record<string, unknown> {
  const cut = (text: string | null, room: number) => (text === null ? null : text.slice(0, room));
  for (let room = chars; ; room = Math.floor(room / 2)) {
    const shown = {
      ...spore,
      content: cut(spore.content, room)!,
      context: cut(spore.context, room),
      properties: cut(spore.properties, room),
    };
    const truncated = shown.content !== spore.content || shown.context !== spore.context || shown.properties !== spore.properties;
    const answer = { spore: snake(shown), truncated, ...around };
    if (room === 0 || answerBytes({ result: answer }) <= RUN_ANSWER_BYTES) return answer;
  }
}

/** Count one full read against this run's budget and answer the running total. */
async function spendFullRead(ctx: ToolContext, runId: string, agentId: string): Promise<number> {
  let spent = 0;
  await mutateState(
    ctx.env.db,
    { projectId: ctx.projectId },
    agentId,
    `${SPORE_READ_STATE_PREFIX}${runId}`,
    (current) => {
      const held = Number(current ?? 0);
      spent = (Number.isSafeInteger(held) && held > 0 ? held : 0) + 1;
      return String(spent);
    },
    ctx.now,
  );
  return spent;
}

export async function handleRunSpores(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_spores');
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const { window } = run;

  if (input.op === 'get') {
    const id = str(input.id, MAX_ID_CHARS);
    if (id === undefined)
      return runRefusal({
        read: true,
        what: 'spore read',
        actual: `id is ${typeof input.id === 'string' ? input.id.length : 'missing or not text'} characters; expected 1–${MAX_ID_CHARS}`,
        next: { tool: 'myco_run_spores', op: 'list' },
      });
    const spent = await spendFullRead(ctx, run.runId, run.agentId);
    if (spent > window.sporeFullReads) {
      return {
        ...runRefusal({
          read: true,
          what: 'spore read',
          actual: `${spent} full reads requested; the limit is ${window.sporeFullReads}`,
          next: { tool: 'myco_run_spores', op: 'list' },
          repair: 'Use previews and the bodies already read.',
        }),
        spore: null,
        budget: 'spent',
      };
    }
    const spore = await getSpore(db, scope, id);
    if (spore === null)
      return runRefusal({ read: true, what: 'spore read', actual: `spore ${id} not found`, next: { tool: 'myco_run_spores', op: 'list' } });
    const [supersededBy, supersedes] = await Promise.all([listSupersedingSporeIds(db, scope, id), listSupersededSporeIds(db, scope, id)]);
    const asked = int(input.max_chars);
    if (input.max_chars !== undefined && (asked === undefined || asked < 1))
      return runRefusal({
        read: true,
        what: 'spore read',
        actual: `max_chars is ${JSON.stringify(input.max_chars)}; expected a whole number from 1`,
        next: { tool: 'myco_run_spores', op: 'get', id, max_chars: window.sporeBodyChars },
      });
    return fullRead(spore, Math.min(asked ?? window.sporeBodyChars, window.sporeBodyChars), { superseded_by: supersededBy, supersedes });
  }

  const asked = input.status === undefined ? 'active' : input.status;
  if (asked !== 'all' && !(SPORE_STATUSES as readonly unknown[]).includes(asked)) {
    return runRefusal({
      read: true,
      what: 'spore inventory',
      actual: `status is ${JSON.stringify(asked)}; expected ${SPORE_STATUSES.join(', ')} or all`,
      next: { tool: 'myco_run_spores', op: 'list', status: 'active' },
    });
  }
  const options = {
    status: asked === 'all' ? undefined : (asked as string),
    observationType: str(input.observation_type, MAX_ID_CHARS),
    limit: Math.min(int(input.limit) ?? DEFAULT_SPORE_LIMIT, window.sporePage),
    cursor: str(input.cursor, MAX_CURSOR_CHARS),
  };
  const listed = await listSporePage(db, scope, options);
  if (listed === null)
    return runRefusal({
      read: true,
      what: 'spore inventory',
      actual: `the page key ${JSON.stringify(input.cursor)} is not one this inventory answered`,
      next: { tool: 'myco_run_spores', op: 'list', status: asked },
    });
  return {
    spores: listed.rows.map((row) => preview(row, window)),
    has_more: listed.hasMore,
    cursor: listed.cursor,
    ...(listed.total === undefined ? {} : { total: listed.total }),
    ...(listed.counting === undefined ? {} : { counting: listed.counting }),
  };
}
