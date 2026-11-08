import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from '../../core/task-catalogue.js';
import { MAP_WRITE_TOOL, TITLE_WRITE_TOOL } from '../../core/tool-catalogue.js';
import { RUN_WRITE_EVENT } from '../../core/runs.js';
import { producedSql } from '../../read/run-outcome.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { runOriginSql } from '../run-context.js';
import { write } from '../index.js';

/**
 * Work history: one fact per terminal run of an outcome task, each day's rollup of those facts, and the distinct output
 * sessions each supported UTC window holds.
 *
 * A fact equals f(its run and that run's output) after every statement, and a rollup row equals the sum of its facts.
 * In-flight runs have no fact: live state answers for them.
 */
export const WORK_HISTORY_PROJECTION = 'work_history';
export const WORK_HISTORY_READY_SQL = `EXISTS (SELECT 1 FROM projection_catchup WHERE projection='${WORK_HISTORY_PROJECTION}' AND phase='workRuns' AND done=1)`;
export const WORK_TASKS = [EXTRACTION_TASK, TITLING_TASK, MAP_TASK, SEEDING_TASK] as const;
/** The tasks whose output is the spores a run wrote. */
const SPORE_TASKS = [EXTRACTION_TASK, SEEDING_TASK] as const;
const DAY_MS = 86_400_000;
/** A window is `span` UTC days ending on `end_day`; every run contributes to each one its day falls in. */
export const WORK_WINDOW_SPANS = [1, 7] as const;
const quoted = (values: readonly string[]) => `(${values.map(value => `'${value}'`).join(',')})`;
const TASKS = quoted(WORK_TASKS);
const SPORE_TASK_SET = quoted(SPORE_TASKS);
const OUTPUT_TOOLS = quoted([TITLE_WRITE_TOOL, MAP_WRITE_TOOL]);
export const WORK_RUN_ELIGIBLE = `task IN ${TASKS} AND NOT ${IN_FLIGHT_RUN_STATUSES}`;

const at = (row: string) => `COALESCE(${row}.completed_at,${row}.queued_at,${row}.started_at)`;
const day = (row: string) => `CAST(${at(row)}/${DAY_MS} AS INTEGER)`;
const eligible = (row: string) => `${row}.task IN ${TASKS} AND NOT ${row}.${IN_FLIGHT_RUN_STATUSES} AND ${at(row)} IS NOT NULL`;
const titled = (row: string) => `(SELECT CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.session_id') END FROM agent_run_events e
  WHERE e.project_id=${row}.project_id AND e.run_id=${row}.id AND e.event_type='${RUN_WRITE_EVENT}' AND e.tool_name='${TITLE_WRITE_TOOL}' ORDER BY e.id DESC LIMIT 1)`;
const sporeCount = (row: string, value: string) => `(SELECT ${value} FROM spores sp WHERE sp.project_id=${row}.project_id AND sp.author=${row}.id)`;

const FACT_FIELDS = ['task', 'status', 'origin', 'day', 'at', 'tokens', 'cost', 'duration_ms', 'no_cost', 'produced', 'spores', 'sessions', 'title_session', 'listed'] as const;
const fact = (r: string) => {
  const produced = producedSql(r);
  const title = `CASE WHEN ${r}.task='${TITLING_TASK}' THEN ${titled(r)} END`;
  return [
    `COALESCE(${r}.task,'')`, `${r}.status`, runOriginSql(r), day(r), at(r), `${r}.tokens_used`, `${r}.cost_usd`,
    `${r}.completed_at-${r}.started_at`,
    `CASE WHEN ${r}.status IN ('completed','failed') AND ${r}.started_at IS NOT NULL AND ${r}.cost_usd IS NULL THEN 1 ELSE 0 END`,
    `CASE WHEN ${produced} THEN 1 ELSE 0 END`,
    `CASE WHEN ${r}.task IN ${SPORE_TASK_SET} THEN ${sporeCount(r, 'COUNT(*)')} ELSE 0 END`,
    `CASE WHEN ${r}.task IN ${SPORE_TASK_SET} THEN ${sporeCount(r, 'COUNT(DISTINCT sp.session_id)')} ELSE CASE WHEN ${title} IS NOT NULL THEN 1 ELSE 0 END END`,
    title,
    `CASE WHEN ${r}.status='failed' OR (${r}.status='completed' AND ${produced}) THEN 1 ELSE 0 END`,
  ];
};
/** The sessions a run's output came from, for each supplied run, without repeats. */
const wantedOutputs = (keys: string) => `SELECT r.project_id,r.task,sp.session_id,r.id AS run_id,${day('r')} AS day
    FROM (${keys}) k JOIN agent_runs r ON r.project_id=k.project_id AND r.id=k.run_id
    JOIN spores sp ON sp.project_id=r.project_id AND sp.author=r.id
    WHERE ${eligible('r')} AND r.task IN ${SPORE_TASK_SET} AND sp.session_id IS NOT NULL
  UNION
  SELECT r.project_id,r.task,json_extract(e.payload,'$.session_id') AS session_id,r.id AS run_id,${day('r')} AS day
    FROM (${keys}) k JOIN agent_runs r ON r.project_id=k.project_id AND r.id=k.run_id
    JOIN agent_run_events e ON e.project_id=r.project_id AND e.run_id=r.id AND e.event_type='${RUN_WRITE_EVENT}' AND e.tool_name='${TITLE_WRITE_TOOL}'
    WHERE ${eligible('r')} AND r.task='${TITLING_TASK}' AND json_valid(e.payload) AND json_extract(e.payload,'$.session_id') IS NOT NULL`;

/** Re-derive the supplied runs' facts and output memberships from current sources, including during catch-up replay. */
export function reconcileWork(keys: string): string[] {
  const outputs = wantedOutputs(keys);
  return [
    `DELETE FROM work_run_contribution WHERE (project_id,run_id) IN (SELECT project_id,run_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id=work_run_contribution.project_id AND r.id=work_run_contribution.run_id AND ${eligible('r')})`,
    `INSERT INTO work_run_contribution(project_id,run_id,${FACT_FIELDS.join(',')})
      SELECT r.project_id,r.id,${fact('r').join(',')}
      FROM (${keys}) k JOIN agent_runs r ON r.project_id=k.project_id AND r.id=k.run_id WHERE ${eligible('r')}
      ON CONFLICT(project_id,run_id) DO UPDATE SET ${FACT_FIELDS.map(column => `${column}=excluded.${column}`).join(',')}
      WHERE (${FACT_FIELDS.map(column => `work_run_contribution.${column}`).join(',')}) IS NOT (${FACT_FIELDS.map(column => `excluded.${column}`).join(',')})`,
    `DELETE FROM run_output_membership WHERE (project_id,run_id) IN (SELECT project_id,run_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM (${outputs}) w WHERE w.project_id=run_output_membership.project_id AND w.run_id=run_output_membership.run_id AND w.session_id=run_output_membership.session_id)`,
    `INSERT INTO run_output_membership(project_id,task,session_id,run_id,day)
      SELECT DISTINCT project_id,task,session_id,run_id,day FROM (${outputs}) WHERE 1
      ON CONFLICT(project_id,session_id,run_id) DO UPDATE SET task=excluded.task,day=excluded.day
      WHERE (run_output_membership.task,run_output_membership.day) IS NOT (excluded.task,excluded.day)`,
  ];
}

const jsonKeys = `SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS run_id FROM json_each(?1)`;
export const WORK_CATCHUP = reconcileWork(jsonKeys).map((sql, i) => write<[string]>({ name: `runs.workPage${i}`, sql }));

const key = (row: string, run = 'id') => `SELECT ${row}.project_id AS project_id,${row}.${run} AS run_id`;
const hasFact = (row: string, run: string) => `EXISTS(SELECT 1 FROM work_run_contribution c WHERE c.project_id=${row}.project_id AND c.run_id=${row}.${run})`;
const neumaier = (sum: string, x: string) => `CASE WHEN abs(${sum})>=abs(${x}) THEN (${sum}-(${sum}+${x}))+${x} ELSE (${x}-(${sum}+${x}))+${sum} END`;
const lower = (column: string) => `${column}=CASE WHEN ${column} IS NULL OR excluded.${column}<${column} THEN COALESCE(excluded.${column},${column}) ELSE ${column} END`;
const upper = (column: string) => `${column}=CASE WHEN ${column} IS NULL OR excluded.${column}>${column} THEN COALESCE(excluded.${column},${column}) ELSE ${column} END`;
const BOUNDS = [['tokens', 'tokens'], ['cost', 'cost'], ['duration', 'duration_ms']] as const;
/** The start line quotes what completed runs spent, so only a completed bucket carries bounds. */
const bounded = (r: string, f: string) => `CASE WHEN ${r}.status='completed' THEN ${r}.${f} END`;

/** A rollup's counters take the fact; its spend bounds only ever widen on an add. */
const addFact = (r: string) => `INSERT INTO work_daily(project_id,task,day,status,origin,runs,tokens,cost,cost_carry,no_cost,produced,spores,${BOUNDS.flatMap(([b]) => [`${b}_low`, `${b}_high`]).join(',')})
  VALUES(${r}.project_id,${r}.task,${r}.day,${r}.status,${r}.origin,1,COALESCE(${r}.tokens,0),COALESCE(${r}.cost,0),0,${r}.no_cost,${r}.produced,${r}.spores,${BOUNDS.flatMap(([, f]) => [bounded(r, f), bounded(r, f)]).join(',')})
  ON CONFLICT(project_id,task,day,status,origin) DO UPDATE SET runs=runs+1,tokens=tokens+excluded.tokens,cost=cost+excluded.cost,
    cost_carry=cost_carry+${neumaier('cost', 'excluded.cost')},no_cost=no_cost+excluded.no_cost,produced=produced+excluded.produced,spores=spores+excluded.spores,
    ${BOUNDS.flatMap(([b]) => [lower(`${b}_low`), upper(`${b}_high`)]).join(',')}`;
const bucket = (r: string) => `project_id=${r}.project_id AND task=${r}.task AND day=${r}.day AND status=${r}.status AND origin=${r}.origin`;
/** The completed facts of a bucket that report a metric, in that metric's order. */
const owners = (r: string, b: string, f: string) => `work_run_contribution c INDEXED BY idx_work_bound_${b} WHERE c.project_id=${r}.project_id AND c.task=${r}.task AND c.day=${r}.day AND c.origin=${r}.origin AND c.status='completed' AND c.${f} IS NOT NULL`;
/** A bound moves only when its last owner leaves, and then by one seek at each end of that metric's order. */
const removeFact = (r: string) => [
  `UPDATE work_daily SET runs=runs-1,tokens=tokens-COALESCE(${r}.tokens,0),cost=cost-COALESCE(${r}.cost,0),
    cost_carry=cost_carry+${neumaier('cost', `(-COALESCE(${r}.cost,0))`)},no_cost=no_cost-${r}.no_cost,produced=produced-${r}.produced,spores=spores-${r}.spores WHERE ${bucket(r)}`,
  `DELETE FROM work_daily WHERE ${bucket(r)} AND runs<=0`,
  ...BOUNDS.map(([b, f]) => `UPDATE work_daily SET ${b}_low=(SELECT MIN(c.${f}) FROM ${owners(r, b, f)}),${b}_high=(SELECT MAX(c.${f}) FROM ${owners(r, b, f)})
    WHERE ${bucket(r)} AND ${r}.status='completed' AND ${r}.${f} IS NOT NULL AND (${b}_low IS ${r}.${f} OR ${b}_high IS ${r}.${f})
      AND NOT EXISTS(SELECT 1 FROM ${owners(r, b, f)} AND c.${f}=${r}.${f})`),
];

/** The windows one output day falls in: a span of `s` days ending on any of the `s` days from it. */
const WINDOWS = JSON.stringify(WORK_WINDOW_SPANS.flatMap(span => Array.from({ length: span }, (_, offset) => [span, offset])));
const windowsOf = (r: string) => `SELECT ${r}.project_id AS project_id,${r}.task AS task,json_extract(w.value,'$[0]') AS span_days,${r}.day+json_extract(w.value,'$[1]') AS end_day,${r}.session_id AS session_id FROM json_each('${WINDOWS}') w`;
const addMembership = (r: string) => `INSERT INTO work_window_sessions(project_id,task,span_days,end_day,session_id,refs) SELECT project_id,task,span_days,end_day,session_id,1 FROM (${windowsOf(r)}) WHERE 1
  ON CONFLICT(project_id,task,span_days,end_day,session_id) DO UPDATE SET refs=refs+1`;
const removeMembership = (r: string) => [
  `UPDATE work_window_sessions SET refs=refs-1 WHERE (project_id,task,span_days,end_day,session_id) IN (${windowsOf(r)})`,
  `DELETE FROM work_window_sessions WHERE (project_id,task,span_days,end_day,session_id) IN (${windowsOf(r)}) AND refs<=0`,
];
const countWindow = (r: string, by: number) => `INSERT INTO work_window_totals(project_id,task,span_days,end_day,sessions) VALUES(${r}.project_id,${r}.task,${r}.span_days,${r}.end_day,${by})
  ON CONFLICT(project_id,task,span_days,end_day) DO UPDATE SET sessions=sessions+excluded.sessions`;
const windowKey = (r: string) => `project_id=${r}.project_id AND task=${r}.task AND span_days=${r}.span_days AND end_day=${r}.end_day`;

const RUN_COLUMNS = ['project_id', 'id', 'task', 'status', 'origin', 'dispatch_spec', 'queued_at', 'started_at', 'completed_at', 'tokens_used', 'cost_usd', 'dry_run'];
const taskIn = (row: string) => `${row}.task IN ${TASKS}`;

export function workTriggers(): Array<{ name: string; table: string; sql: string }> {
  const trigger = (name: string, table: string, event: string, body: string[], when = '') => ({ name, table,
    sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when ? ` WHEN ${when}` : ''} BEGIN ${body.join('; ')}; END` });
  const changed = (columns: readonly string[]) => columns.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  return [
    trigger('work_run_insert', 'agent_runs', 'INSERT', reconcileWork(key('NEW')), `${taskIn('NEW')} AND NOT NEW.${IN_FLIGHT_RUN_STATUSES}`),
    trigger('work_run_update', 'agent_runs', `UPDATE OF ${RUN_COLUMNS.join(',')}`, reconcileWork(`${key('OLD')} UNION ${key('NEW')}`),
      `(${changed(RUN_COLUMNS)}) AND (${taskIn('OLD')} OR ${taskIn('NEW')}) AND (NOT OLD.${IN_FLIGHT_RUN_STATUSES} OR NOT NEW.${IN_FLIGHT_RUN_STATUSES})`),
    trigger('work_run_delete', 'agent_runs', 'DELETE', reconcileWork(key('OLD')), taskIn('OLD')),
    trigger('work_spore_insert', 'spores', 'INSERT', reconcileWork(key('NEW', 'author')), `NEW.author IS NOT NULL AND ${hasFact('NEW', 'author')}`),
    trigger('work_spore_update', 'spores', 'UPDATE OF project_id,author,session_id', reconcileWork(`${key('OLD', 'author')} UNION ${key('NEW', 'author')}`),
      `(${changed(['project_id', 'author', 'session_id'])}) AND (${hasFact('OLD', 'author')} OR ${hasFact('NEW', 'author')})`),
    trigger('work_spore_delete', 'spores', 'DELETE', reconcileWork(key('OLD', 'author')), `OLD.author IS NOT NULL AND ${hasFact('OLD', 'author')}`),
    ...['INSERT', 'DELETE'].map(action => {
      const row = action === 'INSERT' ? 'NEW' : 'OLD';
      return trigger(`work_event_${action.toLowerCase()}`, 'agent_run_events', action, reconcileWork(key(row, 'run_id')),
        `${row}.event_type='${RUN_WRITE_EVENT}' AND ${row}.tool_name IN ${OUTPUT_TOOLS} AND ${hasFact(row, 'run_id')}`);
    }),
    trigger('work_fact_add', 'work_run_contribution', 'INSERT', [addFact('NEW')]),
    trigger('work_fact_remove', 'work_run_contribution', 'DELETE', removeFact('OLD')),
    trigger('work_fact_move', 'work_run_contribution', 'UPDATE', [...removeFact('OLD'), addFact('NEW')]),
    trigger('work_output_add', 'run_output_membership', 'INSERT', [addMembership('NEW')]),
    trigger('work_output_remove', 'run_output_membership', 'DELETE', removeMembership('OLD')),
    trigger('work_output_move', 'run_output_membership', 'UPDATE', [...removeMembership('OLD'), addMembership('NEW')]),
    trigger('work_window_add', 'work_window_sessions', 'INSERT', [countWindow('NEW', 1)]),
    trigger('work_window_remove', 'work_window_sessions', 'DELETE', [countWindow('OLD', -1), `DELETE FROM work_window_totals WHERE ${windowKey('OLD')} AND sessions<=0`]),
  ];
}

export function workSchemaStatements(): string[] {
  const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;
  return [
    `CREATE TABLE IF NOT EXISTS work_run_contribution(${project},run_id TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL,
      day INTEGER NOT NULL,at INTEGER NOT NULL,tokens INTEGER,cost REAL,duration_ms INTEGER,no_cost INTEGER NOT NULL,produced INTEGER NOT NULL,
      spores INTEGER NOT NULL,sessions INTEGER NOT NULL,title_session TEXT,listed INTEGER NOT NULL,PRIMARY KEY(project_id,run_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_work_run_latest ON work_run_contribution(project_id,task,at,run_id)',
    "CREATE INDEX IF NOT EXISTS idx_work_run_failed ON work_run_contribution(project_id,task,at,run_id) WHERE status='failed' AND produced=0",
    'CREATE INDEX IF NOT EXISTS idx_work_timeline_project ON work_run_contribution(project_id,at,run_id) WHERE listed=1',
    'CREATE INDEX IF NOT EXISTS idx_work_timeline ON work_run_contribution(at,project_id,run_id) WHERE listed=1',
    ...BOUNDS.map(([b, f]) => `CREATE INDEX IF NOT EXISTS idx_work_bound_${b} ON work_run_contribution(project_id,task,day,origin,${f}) WHERE status='completed' AND ${f} IS NOT NULL`),
    `CREATE TABLE IF NOT EXISTS work_daily(${project},task TEXT NOT NULL,day INTEGER NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL,
      runs INTEGER NOT NULL,tokens INTEGER NOT NULL,cost REAL NOT NULL,cost_carry REAL NOT NULL,no_cost INTEGER NOT NULL,produced INTEGER NOT NULL,spores INTEGER NOT NULL,
      tokens_low INTEGER,tokens_high INTEGER,cost_low REAL,cost_high REAL,duration_low INTEGER,duration_high INTEGER,
      PRIMARY KEY(project_id,task,day,status,origin)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS run_output_membership(${project},task TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,day INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,run_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_run_output_run ON run_output_membership(project_id,run_id)',
    `CREATE TABLE IF NOT EXISTS work_window_sessions(${project},task TEXT NOT NULL,span_days INTEGER NOT NULL,end_day INTEGER NOT NULL,session_id TEXT NOT NULL,refs INTEGER NOT NULL,
      PRIMARY KEY(project_id,task,span_days,end_day,session_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS work_window_totals(${project},task TEXT NOT NULL,span_days INTEGER NOT NULL,end_day INTEGER NOT NULL,sessions INTEGER NOT NULL,
      PRIMARY KEY(project_id,task,span_days,end_day)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_agent_runs_list ON agent_runs(project_id,COALESCE(queued_at,started_at),id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_runs_list_task ON agent_runs(project_id,task,COALESCE(queued_at,started_at),id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_runs_list_window ON agent_runs(project_id,task,COALESCE(completed_at,queued_at,started_at),id)',
    ...workTriggers().map(({ sql }) => sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${WORK_HISTORY_PROJECTION}','workRuns',NOT EXISTS(SELECT 1 FROM agent_runs WHERE ${WORK_RUN_ELIGIBLE}) ON CONFLICT DO NOTHING`,
  ];
}
