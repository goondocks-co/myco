/**
 * The Runs page, across Projects or only the Projects named (`project`):
 *
 * - `GET /api/runs/hours?window=day|week`: runs finished per runner and hour, and failures grouped by cause, runner,
 *   agent and task with the window before for a trend, all from the hourly counters.
 * - `GET /api/runs/finished?window=day|week`: the runs that finished in the window, newest first, 50 to a page by
 *   cursor, narrowed by `task`, `runner`, `agent`, `cause` (or `noTask`, `noRunner`, `noAgent`, `noCause` for runs that
 *   recorded none) and `outcome` (`worked`, `unchanged` or `failed`).
 *
 * A member reads both, as on Myco's work.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';
import { FINISHED_RUNS_PAGE, RUN_WINDOWS, readFinishedRuns, readRunHours, runWindow, type RunWindow } from '../read/run-hours.js';
import { RUN_OUTCOMES, type EndedRunCursor, type EndedRunFilters, type RunOutcome } from '../db/runs/hour-reads.js';

const WINDOW_NAMES = Object.keys(RUN_WINDOWS) as RunWindow[];
const isWindow = (value: string): value is RunWindow => (WINDOW_NAMES as string[]).includes(value);
const isOutcome = (value: string): value is RunOutcome => (RUN_OUTCOMES as readonly string[]).includes(value);

function windowParam(url: URL): RunWindow | Response {
  const raw = url.searchParams.get('window');
  if (raw === null) return 'day';
  return isWindow(raw) ? raw : badRequest(`window must be one of ${WINDOW_NAMES.join(', ')}, not ${JSON.stringify(raw)}; omit it for a day`);
}

async function scope(env: ServerEnv, ctx: OwnerContext) {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  return (await resolveProjectSet(env.db, ctx.member, named)) ?? notFound();
}

export async function handleRunHours(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const window = windowParam(ctx.url);
  if (window instanceof Response) return window;
  const set = await scope(env, ctx);
  if (set instanceof Response) return set;
  return ok(await readRunHours(env.db, set, window, ctx.now));
}

/** The run a cursor names, or null for text this route never answered. */
function cursorKey(raw: string): EndedRunCursor | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.length === 3 && Number.isSafeInteger(value[0]) && typeof value[1] === 'string' && typeof value[2] === 'string' && value[2] !== '')
      return { completedAt: value[0] as number, projectId: value[1], runId: value[2] };
  } catch { /* not a cursor this route answered */ }
  return null;
}

/**
 * Each filter's query parameter, beside the field it narrows. `<param>=<value>` keeps the runs that recorded the value;
 * its `no<Param>=1` form keeps the runs that recorded none; neither keeps every run.
 */
const TEXT_FILTERS = [['task', 'noTask', 'task'], ['runner', 'noRunner', 'runnerId'], ['agent', 'noAgent', 'harness'], ['cause', 'noCause', 'errorCode']] as const;

export async function handleFinishedRuns(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const window = windowParam(ctx.url);
  if (window instanceof Response) return window;
  const params = ctx.url.searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? FINISHED_RUNS_PAGE : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FINISHED_RUNS_PAGE)
    return badRequest(`limit must be a whole number from 1 to ${FINISHED_RUNS_PAGE}, not ${JSON.stringify(rawLimit)}; omit it for a page of ${FINISHED_RUNS_PAGE}`);
  const filters: EndedRunFilters = {};
  for (const [param, none, field] of TEXT_FILTERS) {
    const value = params.get(param);
    const recordedNone = params.get(none);
    if (recordedNone !== null && recordedNone !== '1') return badRequest(`${none} must be 1, not ${JSON.stringify(recordedNone)}; omit it to keep runs whatever their ${param}`);
    if (recordedNone !== null && value !== null) return badRequest(`name ${param} or ${none}=1, not both: ${param} keeps runs that recorded it, ${none}=1 runs that recorded none`);
    if (recordedNone !== null) filters[field] = '';
    else if (value !== null && value !== '') filters[field] = value;
  }
  const outcome = params.get('outcome');
  if (outcome !== null) {
    if (!isOutcome(outcome)) return badRequest(`outcome must be one of ${RUN_OUTCOMES.join(', ')}, not ${JSON.stringify(outcome)}; omit it for every run`);
    filters.outcome = outcome;
  }
  const rawCursor = ctx.url.searchParams.get('cursor');
  const cursor = rawCursor === null ? undefined : cursorKey(rawCursor);
  if (cursor === null) return badRequest('cursor is not one this route answered; pass the cursor of the previous page, or omit it for the newest page');
  const set = await scope(env, ctx);
  if (set instanceof Response) return set;
  const page = await readFinishedRuns(env.db, set, { ...runWindow(window, ctx.now), filters, limit, ...(cursor === undefined ? {} : { cursor }) });
  return ok({ rows: page.rows, cursor: page.cursor === null ? null : JSON.stringify([page.cursor.completedAt, page.cursor.projectId, page.cursor.runId]) });
}
