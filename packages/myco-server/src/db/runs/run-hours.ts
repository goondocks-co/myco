/**
 * Finished runs, counted once: one `run_finished` fact per run that finished (completed or failed) in the kept window,
 * and the `run_hour` counters, one row per hour, Project, task, runner, agent, result and error code, summing those
 * facts' runs and queue waits.
 *
 * A fact is keyed by its run and written with ON CONFLICT DO NOTHING by both of its writers: the trigger on a run's
 * finish (or its insert as finished), and the catch-up over the runs that finished before. Only a fact actually
 * inserted adds to its hour, through the trigger on `run_finished`, so a run that both writers reach, or that two
 * catch-up pages reach, counts once. A run's finish writes only its fact and its hour; the wake's run-hour retention
 * drops facts and hours older than `RUN_HOUR_RETENTION_MS` a bounded page at a time, so both hold about that many days. Facts also carry each run's filter values with an index
 * leading by each, so a narrowed page of finished runs seeks its matches.
 *
 * A value a run never recorded (no task, runner, agent or error code) is stored as '' and read as "none recorded".
 */
import { write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { jsonKeys, trigger, type Trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';
import { runResultSql } from './run-output.js';

export const RUN_HOUR_PROJECTION = 'run_hour';
const RUN_HOUR_PHASE = 'runHours';
export const HOUR_MS = 3_600_000;
/** How long finished runs are counted and listed: 31 days, the widest window Myco's work reads. */
export const RUN_HOUR_RETENTION_MS = 31 * 24 * HOUR_MS;
/** The statuses a counted run ends in. */
export const FINISHED_RUN_STATUSES = "status IN ('completed','failed')";
const MARK_RUNS = "UPDATE change_marks SET revision=revision+1 WHERE kind='runs'";

/** The runner that ran a run: the runner of the attempt that dispatched it, else the runner holding it; '' for none. */
const runRunnerSql = (r: string): string => `COALESCE((SELECT a.runner_id FROM agent_run_attempts a
  WHERE a.project_id=${r}.project_id AND a.run_id=${r}.id AND a.attempt_id=${r}.dispatched_by),${r}.leased_runner_id,'')`;
/** How long a run waited in the queue before it started; 0 for a run that started at once. */
const waited = (r: string) => `CASE WHEN ${r}.queued_at IS NOT NULL AND ${r}.started_at>${r}.queued_at THEN ${r}.started_at-${r}.queued_at ELSE 0 END`;
const hourOf = (instant: string) => `CAST(${instant}/${HOUR_MS} AS INTEGER)*${HOUR_MS}`;
/** A result as the Runs page reads it: worked, changed nothing, or failed. */
const outcomeOf = (result: string) => `CASE ${result} WHEN 'produced' THEN 'worked' WHEN 'unchanged' THEN 'unchanged' ELSE 'failed' END`;

/** The filters a fact carries, each with the index that leads by it. */
export const FACT_FILTERS = ['error_code', 'runner_id', 'harness', 'task', 'outcome'] as const;
export type FactFilter = typeof FACT_FILTERS[number];
const BUCKET = ['hour', 'project_id', 'task', 'runner_id', 'harness', 'result', 'error_code'] as const;
const FACT = ['project_id', 'run_id', 'at', 'hour', 'task', 'runner_id', 'harness', 'result', 'outcome', 'error_code', 'wait_ms'] as const;
/** A run's fact, its columns in `FACT` order, over the run row `r`. */
const factOf = (r: string) => {
  const result = runResultSql(r);
  return [`${r}.project_id`, `${r}.id`, `${r}.completed_at`, hourOf(`${r}.completed_at`), `COALESCE(${r}.task,'')`, runRunnerSql(r),
    `COALESCE(${r}.harness,'')`, result, outcomeOf(result), `COALESCE(${r}.error_code,'')`, waited(r)];
};
const insertFacts = (select: string) => `INSERT INTO run_finished(${FACT.join(',')}) ${select} ON CONFLICT(project_id,run_id) DO NOTHING`;

const finishedNow = (row: string) => `${row}.${FINISHED_RUN_STATUSES} AND ${row}.completed_at IS NOT NULL`;
const countFact = `INSERT INTO run_hour(${BUCKET.join(',')},runs,wait_ms) VALUES(${BUCKET.map(column => `NEW.${column}`).join(',')},1,NEW.wait_ms)
  ON CONFLICT(${BUCKET.join(',')}) DO UPDATE SET runs=runs+1,wait_ms=wait_ms+excluded.wait_ms`;
export function runHourTriggers(): Trigger[] {
  return [
    trigger('run_hour_finish', 'agent_runs', 'UPDATE OF status', [insertFacts(`SELECT ${factOf('NEW').join(',')} WHERE 1`)], `${finishedNow('NEW')} AND NOT OLD.${FINISHED_RUN_STATUSES}`),
    trigger('run_hour_insert', 'agent_runs', 'INSERT', [insertFacts(`SELECT ${factOf('NEW').join(',')} WHERE 1`)], finishedNow('NEW')),
    trigger('run_hour_count', 'run_finished', 'INSERT', [countFact]),
    trigger('run_hour_ready_mark', 'projection_catchup', 'UPDATE OF done', [MARK_RUNS], `NEW.projection='${RUN_HOUR_PROJECTION}' AND OLD.done IS NOT NEW.done`),
  ];
}

const PAGE_KEYS = jsonKeys(['project_id', 'id']);
const catchupFacts = write<[keys: string, keptFrom: number]>({ name: 'runHours.catchupFacts', sql: insertFacts(`SELECT ${factOf('r').join(',')}
  FROM (${PAGE_KEYS}) k JOIN agent_runs r ON r.project_id=k.project_id AND r.id=k.id WHERE r.${FINISHED_RUN_STATUSES} AND r.completed_at>=?2`) });
/** Each catch-up page moves the runs mark in its own commit, so a page following the counts reads them again. */
const catchupMark = write<[keys: string]>({ name: 'runHours.catchupMark', sql: `${MARK_RUNS} AND EXISTS(SELECT 1 FROM json_each(?1))` });
const clearHours = write<[]>({ name: 'runHours.clearHours', sql: 'DELETE FROM run_hour' });
const clearFacts = write<[]>({ name: 'runHours.clearFacts', sql: 'DELETE FROM run_finished' });

export const RUN_HOUR_CATCHUP = {
  projection: RUN_HOUR_PROJECTION,
  reset: () => [clearHours.bind(), clearFacts.bind()],
  phases: {
    [RUN_HOUR_PHASE]: {
      source: { table: 'agent_runs', columns: ['project_id', 'id'], where: `${FINISHED_RUN_STATUSES} AND completed_at IS NOT NULL`, unique: true },
      reconcile: [{ bindAt: (keys: string, now: number) => catchupFacts.bind(keys, now - RUN_HOUR_RETENTION_MS) }, catchupMark],
    },
  },
} as const satisfies CatchupFamily;

/** The fact and counter tables, the fact indexes, the triggers and the catch-up seed. */
export function runHourSchemaStatements(): string[] {
  const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;
  return [
    `CREATE TABLE IF NOT EXISTS run_finished(${project},run_id TEXT NOT NULL,at INTEGER NOT NULL,hour INTEGER NOT NULL,task TEXT NOT NULL,runner_id TEXT NOT NULL,
      harness TEXT NOT NULL,result TEXT NOT NULL,outcome TEXT NOT NULL,error_code TEXT NOT NULL,wait_ms INTEGER NOT NULL,PRIMARY KEY(project_id,run_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_run_finished_at ON run_finished(at,project_id,run_id)',
    'CREATE INDEX IF NOT EXISTS idx_run_finished_project ON run_finished(project_id,at,run_id)',
    ...FACT_FILTERS.map(filter => `CREATE INDEX IF NOT EXISTS idx_run_finished_${filter} ON run_finished(${filter},at,project_id,run_id)`),
    `CREATE TABLE IF NOT EXISTS run_hour(hour INTEGER NOT NULL,${project},task TEXT NOT NULL,runner_id TEXT NOT NULL,
      harness TEXT NOT NULL,result TEXT NOT NULL,error_code TEXT NOT NULL,runs INTEGER NOT NULL,wait_ms INTEGER NOT NULL,
      PRIMARY KEY(${BUCKET.join(',')})) WITHOUT ROWID`,
    ...runHourTriggers().map(({ sql }) => sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${RUN_HOUR_PROJECTION}','${RUN_HOUR_PHASE}',
      NOT EXISTS(SELECT 1 FROM agent_runs WHERE ${FINISHED_RUN_STATUSES} AND completed_at IS NOT NULL) ON CONFLICT DO NOTHING`,
  ];
}

const expiredFacts = write<[before: number, limit: number], { gone: number }>({ name: 'runHours.pruneFacts', sql: `DELETE FROM run_finished WHERE (project_id,run_id) IN
  (SELECT project_id,run_id FROM run_finished INDEXED BY idx_run_finished_at WHERE at<?1 ORDER BY at LIMIT ?2) RETURNING 1 AS gone` });
const expiredHours = write<[before: number, limit: number], { gone: number }>({ name: 'runHours.pruneHours', sql: `DELETE FROM run_hour WHERE (${BUCKET.join(',')}) IN
  (SELECT ${BUCKET.join(',')} FROM run_hour WHERE hour<?1 ORDER BY hour LIMIT ?2) RETURNING 1 AS gone` });

/** Up to `limit` facts and up to `limit` hour rows from before the whole hour `boundary`, oldest first. */
export const pruneRunHourStatements = (boundary: number, limit: number) => [expiredFacts.bind(boundary, limit), expiredHours.bind(boundary, limit)] as const;
