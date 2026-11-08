import type { RelationalStore } from '../../core/adapters.js';
import { BUDGET_WINDOW_MS, stageSeedSql, workerTaskSql } from '../../core/budget-policy.js';
import { runOriginSql } from '../run-context.js';
import { LIVE_RUN_STATUSES } from '../run-statuses.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { read, readSet, write } from '../index.js';

/**
 * Rolling spend accounting: one `attempt_spend` fact per worker-task attempt, holding the attempt's absolute
 * contribution, and `budget_totals`, the sum of every counted fact per Project and origin.
 *
 * A fact is live while its run is pending or running under that attempt; a live fact always counts. A settled fact
 * counts until its claim leaves the rolling window. Expiry is due rows: settled facts still counted with
 * `claimed_at <= floor`. Each new attempt expires a bounded page of them, and every read subtracts the remainder, so
 * the snapshot at `now` equals the spend relation at `now` without reading attempt history.
 */
export const BUDGET_PROJECTION = 'budget';
export const SPEND_EXPIRY_PAGE = 8;

const micros = (value: string) => `CAST(round((${value})*1000000) AS INTEGER)`;
const unconfirmed = (row: string) => `(${row}.live=0 AND COALESCE(${row}.cost_source,'') NOT IN ('actual','estimated'))`;
const SETTLED = "r.status IN ('completed','failed','skipped')";
const LIVE = `r.${LIVE_RUN_STATUSES} AND r.dispatched_by IS a.attempt_id`;
const COLUMNS = ['claimed_at', 'origin', 'task', 'value', 'estimate', 'cost_source', 'live'] as const;

/** One source row per attempt key: the same definition the claim-time spend relation used. */
function spendSource(keys: string): string {
  const seed = stageSeedSql('r.task');
  return `SELECT a.project_id,a.run_id,a.attempt_id,a.claimed_at,${runOriginSql('r')} AS origin,r.task,
    COALESCE(a.cost_usd,a.estimate_usd,CASE WHEN ${SETTLED} AND a.attempt_id=r.dispatched_by THEN r.cost_usd END,${seed}) AS value,
    COALESCE(a.estimate_usd,${seed}) AS estimate,
    CASE WHEN a.cost_usd IS NOT NULL THEN COALESCE(a.cost_source,'actual')
      WHEN a.estimate_usd IS NULL AND ${SETTLED} AND a.attempt_id=r.dispatched_by AND r.cost_usd IS NOT NULL THEN COALESCE(r.cost_source,'actual')
      ELSE a.cost_source END AS cost_source,
    CASE WHEN ${LIVE} THEN 1 ELSE 0 END AS live
    FROM (${keys}) k JOIN agent_run_attempts a ON a.project_id=k.project_id AND a.run_id=k.run_id AND a.attempt_id=k.attempt_id
    JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id WHERE ${workerTaskSql('r.task')}`;
}

/**
 * The absolute reconcile for a set of attempt keys. `floor` is the expiry floor a catch-up page applies to settled
 * history, and `NULL` inside triggers, where a newly settled fact counts until the due-row expiry takes it.
 * An expired fact stays expired unless its claim moves later.
 */
export function reconcileSpend(keys: string, floor: string): string[] {
  const counted = `CASE WHEN excluded.live=1 THEN 1 WHEN attempt_spend.counted=0 AND excluded.claimed_at<=attempt_spend.claimed_at THEN 0 ELSE excluded.counted END`;
  return [
    `DELETE FROM attempt_spend WHERE (project_id,run_id,attempt_id) IN (SELECT project_id,run_id,attempt_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM agent_run_attempts a JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id
        WHERE a.project_id=attempt_spend.project_id AND a.run_id=attempt_spend.run_id AND a.attempt_id=attempt_spend.attempt_id AND ${workerTaskSql('r.task')})`,
    `INSERT INTO attempt_spend(project_id,run_id,attempt_id,${COLUMNS.join(',')},counted)
      SELECT project_id,run_id,attempt_id,${COLUMNS.join(',')},CASE WHEN live=1 THEN 1 WHEN claimed_at<=${floor} THEN 0 ELSE 1 END FROM (${spendSource(keys)}) WHERE true
      ON CONFLICT(project_id,run_id,attempt_id) DO UPDATE SET ${COLUMNS.map(column => `${column}=excluded.${column}`).join(',')},counted=${counted}
      WHERE (${COLUMNS.map(column => `attempt_spend.${column}`).join(',')},attempt_spend.counted) IS NOT (${COLUMNS.map(column => `excluded.${column}`).join(',')},${counted})`,
  ];
}

const attemptKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.run_id AS run_id,${row}.attempt_id AS attempt_id`;
const runKeys = 'SELECT project_id,run_id,attempt_id FROM agent_run_attempts WHERE project_id=NEW.project_id AND run_id=NEW.id';
export const SPEND_JSON_KEYS = `SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS run_id,json_extract(value,'$[2]') AS attempt_id FROM json_each(?1)`;

/** A due page: settled facts whose claim left the window ending at `claimed`. */
const expire = (claimed: string) => `UPDATE attempt_spend SET counted=0 WHERE (project_id,run_id,attempt_id) IN (SELECT project_id,run_id,attempt_id FROM attempt_spend
  WHERE counted=1 AND live=0 AND claimed_at<=${claimed}-${BUDGET_WINDOW_MS} ORDER BY claimed_at LIMIT ${SPEND_EXPIRY_PAGE})`;

const contribution = (row: string) => [micros(`${row}.value`), `CASE WHEN ${row}.live=1 THEN ${micros(`${row}.value`)} ELSE 0 END`,
  `CASE WHEN ${unconfirmed(row)} THEN 1 ELSE 0 END`, `CASE WHEN ${unconfirmed(row)} THEN ${micros(`${row}.estimate`)} ELSE 0 END`];
const TOTALS = ['micros', 'live_micros', 'unconfirmed', 'unconfirmed_estimate_micros'] as const;
const add = `INSERT INTO budget_totals(project_id,origin,${TOTALS.join(',')}) VALUES(NEW.project_id,NEW.origin,${contribution('NEW').join(',')})
  ON CONFLICT(project_id,origin) DO UPDATE SET ${TOTALS.map(column => `${column}=${column}+excluded.${column}`).join(',')}`;
const subtract = `UPDATE budget_totals SET ${TOTALS.map((column, i) => `${column}=${column}-${contribution('OLD')[i]}`).join(',')}
  WHERE project_id=OLD.project_id AND origin=OLD.origin`;

/** A fact that keeps its Project and origin moves its one rollup row by the difference. */
const SAME_ROLLUP = 'OLD.project_id=NEW.project_id AND OLD.origin=NEW.origin';

export interface SpendTrigger { name: string; table: string; sql: string }
/** Triggers in the order the schema step installs them. Their SQL is frozen in the step file. */
export function spendTriggers(): SpendTrigger[] {
  const trigger = (name: string, table: string, event: string, body: readonly string[], when = '') =>
    ({ name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when ? ` WHEN ${when}` : ''} BEGIN ${body.join('; ')}; END` });
  const worker = (row: string) => workerTaskSql(`${row}.task`);
  const runColumns = ['status', 'dispatched_by', 'cost_usd', 'cost_source', 'task'];
  const attemptColumns = ['claimed_at', 'estimate_usd', 'cost_usd', 'cost_source'];
  const changed = (columns: readonly string[]) => columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
  return [
    trigger('attempt_spend_add', 'attempt_spend', 'INSERT', [add], 'NEW.counted=1'),
    trigger('attempt_spend_remove', 'attempt_spend', 'DELETE', [subtract], 'OLD.counted=1'),
    trigger('attempt_spend_move', 'attempt_spend', 'UPDATE', [
      `INSERT INTO budget_totals(project_id,origin,${TOTALS.join(',')}) SELECT NEW.project_id,NEW.origin,
        ${contribution('NEW').map((value, i) => `NEW.counted*(${value})-OLD.counted*(${contribution('OLD')[i]})`).join(',')}
        WHERE ${SAME_ROLLUP} ON CONFLICT(project_id,origin) DO UPDATE SET ${TOTALS.map(column => `${column}=${column}+excluded.${column}`).join(',')}`,
      `${subtract} AND OLD.counted=1 AND NOT (${SAME_ROLLUP})`,
      `INSERT INTO budget_totals(project_id,origin,${TOTALS.join(',')}) SELECT NEW.project_id,NEW.origin,${contribution('NEW').join(',')} WHERE NEW.counted=1 AND NOT (${SAME_ROLLUP})
        ON CONFLICT(project_id,origin) DO UPDATE SET ${TOTALS.map(column => `${column}=${column}+excluded.${column}`).join(',')}`,
    ]),
    trigger('attempt_spend_attempt_insert', 'agent_run_attempts', 'INSERT', [...reconcileSpend(attemptKey('NEW'), 'NULL'), expire('NEW.claimed_at')]),
    trigger('attempt_spend_attempt_update', 'agent_run_attempts', `UPDATE OF ${attemptColumns.join(',')}`, reconcileSpend(attemptKey('NEW'), 'NULL'), changed(attemptColumns)),
    trigger('attempt_spend_attempt_delete', 'agent_run_attempts', 'DELETE',
      ['DELETE FROM attempt_spend WHERE project_id=OLD.project_id AND run_id=OLD.run_id AND attempt_id=OLD.attempt_id']),
    trigger('attempt_spend_run_update', 'agent_runs', `UPDATE OF ${runColumns.join(',')}`, reconcileSpend(runKeys, 'NULL'),
      `(${worker('OLD')} OR ${worker('NEW')}) AND (${changed(runColumns)})`),
  ];
}

/** Tables, indexes, triggers and readiness: the statements the schema step freezes. */
export function spendSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS attempt_spend(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,claimed_at INTEGER NOT NULL,
      origin TEXT NOT NULL,task TEXT NOT NULL,value REAL NOT NULL,estimate REAL NOT NULL,cost_source TEXT,
      live INTEGER NOT NULL CHECK(live IN (0,1)),counted INTEGER NOT NULL CHECK(counted IN (0,1)),
      PRIMARY KEY(project_id,run_id,attempt_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_attempt_spend_window ON attempt_spend(claimed_at) WHERE counted=1 AND live=0',
    'CREATE INDEX IF NOT EXISTS idx_attempt_spend_live ON attempt_spend(origin,project_id) WHERE live=1',
    `CREATE TABLE IF NOT EXISTS budget_totals(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),origin TEXT NOT NULL,micros INTEGER NOT NULL DEFAULT 0,
      live_micros INTEGER NOT NULL DEFAULT 0,unconfirmed INTEGER NOT NULL DEFAULT 0,unconfirmed_estimate_micros INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,origin)) WITHOUT ROWID`,
    ...spendTriggers().map(trigger => trigger.sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${BUDGET_PROJECTION}','attempts',NOT EXISTS (SELECT 1 FROM agent_run_attempts)`,
  ];
}

/** Catch-up pages reconcile attempt keys against the floor of the instant they run. */
const [spendRetract, spendUpsert] = reconcileSpend(SPEND_JSON_KEYS, '?2');
const catchupRetract = write<[string]>({ name: 'runs.spendPageRetract', sql: spendRetract! });
const catchupUpsert = write<[string, number]>({ name: 'runs.spendPageUpsert', sql: spendUpsert! });
export const SPEND_CATCHUP = [
  { bind: (keys: string, _floor: number) => catchupRetract.bind(keys) },
  { bind: (keys: string, floor: number) => catchupUpsert.bind(keys, floor) },
] as const;

/** Accounting readiness, as a SQL predicate: every catch-up phase of the projection is done. */
export const SPEND_READY_SQL = `NOT EXISTS (SELECT 1 FROM projection_catchup WHERE projection='${BUDGET_PROJECTION}' AND done=0)`;

/** Due expiry not yet consumed at `floor`, subtracted from the rollup. */
const due = (floor: string, extra = '') => `FROM attempt_spend WHERE counted=1 AND live=0 AND claimed_at<=${floor}${extra}`;

/**
 * Rolling spend in micro-dollars at the floor slot, optionally restricted: the rollup minus unconsumed expiry.
 * Reads the Project/origin rollup rows and the due rows only.
 */
export function spentMicrosSql(floor: string, filter: { origin?: string; project?: string } = {}): string {
  const where = [filter.origin === undefined ? null : `origin=${filter.origin}`, filter.project === undefined ? null : `project_id=${filter.project}`]
    .filter(term => term !== null);
  const and = where.length === 0 ? '' : ` AND ${where.join(' AND ')}`;
  return `((SELECT COALESCE(SUM(micros),0) FROM budget_totals WHERE 1${and})-(SELECT COALESCE(SUM(${micros('value')}),0) ${due(floor, and)}))`;
}

/** Facts counted at `floor`, one row per attempt: the window's settled facts and every live one. */
export function spendRowsSql(floor: string): string {
  const columns = `s.value,s.estimate,s.cost_source AS costSource,a.profile_json AS profileJson,s.project_id AS projectId,s.task,s.origin,s.attempt_id AS attemptId,s.live`;
  const join = 'JOIN agent_run_attempts a ON a.project_id=s.project_id AND a.run_id=s.run_id AND a.attempt_id=s.attempt_id';
  return `SELECT ${columns} FROM attempt_spend s INDEXED BY idx_attempt_spend_window ${join} WHERE s.counted=1 AND s.live=0 AND s.claimed_at>${floor}
    UNION ALL SELECT ${columns} FROM attempt_spend s INDEXED BY idx_attempt_spend_live ${join} WHERE s.live=1`;
}

export interface SpendTotals {
  origin: 'manual' | 'automatic'; micros: number; liveMicros: number; unconfirmed: number; unconfirmedEstimateMicros: number;
}
export interface LiveSpend { projectId: string; task: string; estimate: number; profileJson: string | null }

const totals = read<[number], SpendTotals>({ name: 'runs.spendTotals', sql: `SELECT t.origin,t.micros-COALESCE(d.micros,0) AS micros,t.liveMicros,
  t.unconfirmed-COALESCE(d.unconfirmed,0) AS unconfirmed,t.unconfirmedEstimateMicros-COALESCE(d.estimate,0) AS unconfirmedEstimateMicros
  FROM (SELECT origin,SUM(micros) AS micros,SUM(live_micros) AS liveMicros,SUM(unconfirmed) AS unconfirmed,SUM(unconfirmed_estimate_micros) AS unconfirmedEstimateMicros
    FROM budget_totals GROUP BY origin) t
  LEFT JOIN (SELECT origin,SUM(${micros('value')}) AS micros,SUM(CASE WHEN ${unconfirmed('attempt_spend')} THEN 1 ELSE 0 END) AS unconfirmed,
    SUM(CASE WHEN ${unconfirmed('attempt_spend')} THEN ${micros('estimate')} ELSE 0 END) AS estimate ${due('?1')} GROUP BY origin) d ON d.origin=t.origin` });
const liveAutomatic = read<[], LiveSpend>({ name: 'runs.liveAutomaticSpend', sql: `SELECT s.project_id AS projectId,s.task,s.estimate,a.profile_json AS profileJson
  FROM attempt_spend s INDEXED BY idx_attempt_spend_live JOIN agent_run_attempts a ON a.project_id=s.project_id AND a.run_id=s.run_id AND a.attempt_id=s.attempt_id
  WHERE s.live=1 AND s.origin='automatic'` });
const readiness = read<[], { ready: number }>({ name: 'runs.spendReady', sql: `SELECT ${SPEND_READY_SQL} AS ready` });

/** One snapshot: per-origin totals at `now`, the live automatic exposure rows, and readiness. */
export async function readSpendSnapshot(db: RelationalStore, now: number): Promise<{ ready: boolean; totals: SpendTotals[]; live: LiveSpend[] }> {
  const [rows, live, ready] = await readSet(db, totals.bind(now - BUDGET_WINDOW_MS), liveAutomatic.bind(), readiness.bind());
  return { ready: ready[0]?.ready === 1, totals: rows, live };
}

/** Whether accounting has caught up with attempt history. */
export async function spendReady(db: RelationalStore): Promise<boolean> {
  const [ready] = await readSet(db, readiness.bind());
  return ready[0]?.ready === 1;
}
