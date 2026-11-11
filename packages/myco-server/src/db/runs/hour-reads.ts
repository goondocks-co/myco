/**
 * The Runs page's reads: the hourly counts over a window, and a page of the runs that finished in it across Projects,
 * newest end first, from the finished-run facts. Both read rows inside the window only, so their cost follows the
 * window, never the history a Deployment holds.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { ProjectSet } from '../../read/scope.js';
import { read, readSet } from '../index.js';
import { runNotRetiring } from './evidence-schema.js';
import type { RunResult } from './run-output.js';
import { RUN_HOUR_PROJECTION, type FactFilter } from './run-hours.js';
import { contactHourReads } from '../runners/contact-hours.js';
import { waitHourReads } from './wait-hours.js';

/** One hour's count for one Project-less combination of task, runner, agent, result and error code. */
export interface RunHourRow { hour: number; task: string; runner_id: string; harness: string; result: RunResult; error_code: string; runs: number; wait_ms: number }

const visible = (all: boolean, column: string) => all
  ? `?1 IS NOT NULL AND EXISTS(SELECT 1 FROM projects vp WHERE vp.project_id=${column} AND vp.archived_at IS NULL)`
  : `${column} IN (SELECT value FROM json_each(?1))`;
const setValue = (set: ProjectSet) => set.all ? '' : JSON.stringify(set.projectIds);

const hours = [true, false].map((all) => read<[projects: string, since: number, until: number], RunHourRow>({ name: `runHours.window${all ? 'All' : 'Named'}`,
  sql: `SELECT hour,task,runner_id,harness,result,error_code,SUM(runs) AS runs,SUM(wait_ms) AS wait_ms FROM run_hour h
    WHERE hour>=?2 AND hour<?3 AND ${visible(all, 'h.project_id')} GROUP BY hour,task,runner_id,harness,result,error_code` }));
const ready = read<[], { done: number }>({ name: 'runHours.ready', sql: `SELECT done FROM projection_catchup WHERE projection='${RUN_HOUR_PROJECTION}'` });
const runnerNames = read<[ids: string], { id: string; name: string }>({ name: 'runHours.runnerNames', sql: 'SELECT id,name FROM runners WHERE id IN (SELECT value FROM json_each(?1))' });

/**
 * The hourly counts of the visible Projects in [since, until), whether every earlier run is counted yet, and the runners
 * they name; each runner's check-in hours from `checkinsSince`, the earliest hour check-ins are kept for, the waits in
 * the queue that ended from `checkinsSince` by the hours they began and ended, and the queued work still waiting.
 */
export async function runHourWindow(db: RelationalStore, set: ProjectSet, { since, until, checkinsSince }: { since: number; until: number; checkinsSince: number }) {
  const projects = setValue(set);
  const [rows, phase, checkins, earliest, waits, waiting] = await readSet(db, hours[set.all ? 0 : 1]!.bind(projects, since, until), ready.bind(),
    ...contactHourReads(checkinsSince, until), ...waitHourReads(set, projects, checkinsSince, until));
  const ids = [...new Set([...rows.map((row) => row.runner_id), ...checkins.map((row) => row.runner_id)].filter((id) => id !== ''))];
  const [names] = ids.length === 0 ? [[]] : await readSet(db, runnerNames.bind(JSON.stringify(ids)));
  return {
    rows, counted: phase.length > 0 && phase.every((row) => row.done === 1), runners: new Map(names.map((row) => [row.id, row.name])),
    checkins, recordedSince: earliest[0]?.hour ?? null, waits, waiting,
  };
}

/** How a finished run reads on the Runs page: it changed something, changed nothing, or failed. */
export const RUN_OUTCOMES = ['worked', 'unchanged', 'failed'] as const;
export type RunOutcome = typeof RUN_OUTCOMES[number];
/**
 * What narrows the page of finished runs: an absent filter keeps every run; '' keeps the runs that recorded none
 * (no task, runner, agent or error code); any other value keeps the runs that recorded it.
 */
export interface EndedRunFilters { task?: string; runnerId?: string; harness?: string; errorCode?: string; outcome?: RunOutcome }
export interface EndedRunCursor { completedAt: number; projectId: string; runId: string }
export interface EndedRunRow {
  project_id: string; project_name: string | null; id: string; task: string; result: RunResult; error_code: string;
  harness: string; model: string | null; runner_id: string; runner_name: string | null; queued_at: number | null; started_at: number | null; completed_at: number;
}

/** Each filter's field, in the order a page leads by the first one given. */
const FILTER_FIELDS: ReadonlyArray<[keyof EndedRunFilters, FactFilter]> = [['errorCode', 'error_code'], ['runnerId', 'runner_id'], ['harness', 'harness'], ['task', 'task'], ['outcome', 'outcome']];
/** Slot of each filter: ?4 onward, in `FILTER_FIELDS` order. */
const slot = (index: number) => `?${index + 4}`;
const RESIDUAL = FILTER_FIELDS.map(([, column], i) => `(${slot(i)} IS NULL OR c.${column}=${slot(i)})`).join(' AND ');
type EndedBinds = [projects: string, since: number, until: number, errorCode: string | null, runner: string | null, harness: string | null, task: string | null, outcome: RunOutcome | null, candidates: number];
type EndedAfterBinds = [...EndedBinds, completedAt: number, projectId: string, runId: string];
/** The index a page leads by: a filter's, the one Project's, or when the run ended. */
type Lead = FactFilter | 'project' | 'at';
const leadSql = (lead: Lead) => lead === 'at' ? '1' : lead === 'project' ? "f.project_id=json_extract(?1,'$[0]')" : `f.${lead}=${slot(FILTER_FIELDS.findIndex(([, column]) => column === lead))}`;
/**
 * The page's candidates: at most ?9 facts along the lead index inside the window, after the cursor. Each candidate says
 * whether it matches every filter and is a run a reader may reach; only a match carries its names.
 */
const endedSql = (all: boolean, lead: Lead, keyed: boolean) => `WITH c AS (SELECT f.* FROM run_finished f INDEXED BY idx_run_finished_${lead}
    WHERE ${leadSql(lead)} AND f.at>=?2 AND f.at<?3 ${keyed ? 'AND f.at<=?10 AND (f.at,f.project_id,f.run_id)<(?10,?11,?12)' : ''}
    ORDER BY f.at DESC,f.project_id DESC,f.run_id DESC LIMIT ?9)
  SELECT x.*,CASE WHEN x.matched=1 THEN (SELECT p.name FROM projects p WHERE p.project_id=x.project_id) END AS project_name,
    CASE WHEN x.matched=1 THEN (SELECT n.name FROM runners n WHERE n.id=x.runner_id) END AS runner_name
  FROM (SELECT c.project_id,c.run_id AS id,c.task,c.result,c.error_code,c.harness,c.runner_id,c.at AS completed_at,r.model,r.queued_at,r.started_at,
      CASE WHEN r.id IS NOT NULL AND ${visible(all, 'c.project_id')} AND ${RESIDUAL} AND ${runNotRetiring('c.project_id', 'c.run_id')} THEN 1 ELSE 0 END AS matched
    FROM c LEFT JOIN agent_runs r ON r.project_id=c.project_id AND r.id=c.run_id) x
  ORDER BY x.completed_at DESC,x.project_id DESC,x.id DESC`;
const LEADS: readonly Lead[] = [...FILTER_FIELDS.map(([, column]) => column), 'project', 'at'];
const leadName = (lead: Lead) => lead.split('_').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
type Candidate = EndedRunRow & { matched: number };
const endedPages = new Map(LEADS.flatMap((lead) => [true, false].map((all) => [`${lead}:${all}`, {
  first: read<EndedBinds, Candidate>({ name: `runHours.endedBy${leadName(lead)}${all ? 'All' : 'Named'}`, sql: endedSql(all, lead, false) }),
  after: read<EndedAfterBinds, Candidate>({ name: `runHours.endedBy${leadName(lead)}${all ? 'All' : 'Named'}After`, sql: endedSql(all, lead, true) }),
}] as const)));

/** How many candidates a page inspects at most, per row it may list. */
export const CANDIDATES_PER_ROW = 4;

/** One page of finished runs: the window [since, until), the filters, how many rows, and the run the page continues after. */
export interface EndedRunPage { since: number; until: number; filters: EndedRunFilters; limit: number; cursor?: EndedRunCursor }

/**
 * Up to `limit` runs of the visible Projects that finished in the window, newest end first, after `cursor` where one is
 * given, and where the next page starts: after the last row listed when more matches follow, after the last run
 * inspected when the page stopped at its bound, or null when the window holds no more. The page seeks by its first
 * filter given, else by its one Project, else by when runs ended. A page with other filters beside its seek inspects at
 * most `CANDIDATES_PER_ROW` x `limit` runs along it, so it costs the same however sparse they are; one that stops at
 * that bound may list fewer than `limit` rows, none included, and still continue.
 */
export async function endedRuns(db: RelationalStore, set: ProjectSet, { since, until, filters, limit, cursor }: EndedRunPage): Promise<{ rows: EndedRunRow[]; next: EndedRunCursor | null }> {
  const values = FILTER_FIELDS.map(([field]) => filters[field] ?? null);
  const first = FILTER_FIELDS.find(([field]) => filters[field] !== undefined);
  const lead: Lead = first !== undefined ? first[1] : !set.all && set.projectIds.length === 1 ? 'project' : 'at';
  // With no filter beside the lead, nearly every candidate matches: one past the page tells whether more follow.
  const residual = FILTER_FIELDS.filter(([field]) => filters[field] !== undefined).length > (first === undefined ? 0 : 1);
  const candidates = residual ? CANDIDATES_PER_ROW * limit : limit + 1;
  const binds: EndedBinds = [setValue(set), since, until, values[0]!, values[1]!, values[2]!, values[3]!, values[4] as RunOutcome | null, candidates];
  const pages = endedPages.get(`${lead}:${set.all}`)!;
  const [inspected] = await readSet(db, cursor === undefined ? pages.first.bind(...binds) : pages.after.bind(...binds, cursor.completedAt, cursor.projectId, cursor.runId));
  const matched = inspected.filter((row) => row.matched === 1);
  const at = (row: EndedRunRow): EndedRunCursor => ({ completedAt: Number(row.completed_at), projectId: row.project_id, runId: row.id });
  const rows = matched.slice(0, limit);
  if (matched.length > limit) return { rows, next: at(rows.at(-1)!) };
  return { rows, next: inspected.length === candidates ? at(inspected.at(-1)!) : null };
}
