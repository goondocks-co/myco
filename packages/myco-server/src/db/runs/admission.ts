import type { RelationalStore } from '../../core/adapters.js';
import { BUDGET_WINDOW_MS, stageSeedSql, workerTaskSql } from '../../core/budget-policy.js';
import { runOriginSql } from '../run-context.js';
import { LIVE_RUN_STATUSES } from '../run-statuses.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { commit, read, readSet, write } from '../index.js';
import { changed, jsonKeys, trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * Rolling spend accounting: one `attempt_spend` fact per worker-task attempt, holding the attempt's absolute
 * contribution in the source's own dollars, and `budget_totals`, the sum of every counted fact per Project and origin.
 *
 * A fact is live while its run is pending or running under that attempt; a live fact always counts. A settled fact
 * counts until its claim leaves the rolling window. Expiry is due rows: settled facts still counted with
 * `claimed_at <= floor`. The `spend-expiry` job and each new attempt retire them oldest first in bounded pages. A read
 * subtracts at most one page of due rows and is ready only while no more than that page is overdue, so admission and
 * status read a bounded number of rows however long the Deployment has been idle.
 */
export const BUDGET_PROJECTION = 'budget';
/** Due rows a new attempt retires inline. */
export const SPEND_EXPIRY_PAGE = 8;
/** Due rows a read subtracts; a larger backlog leaves accounting not ready until the expiry job retires it. */
export const SPEND_DUE_READ_LIMIT = 64;
/** Due rows one expiry job page retires. */
export const SPEND_EXPIRY_JOB_PAGE = 256;

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
/** A run's status, dispatch and cost move only the attempt it dispatched before and after the change. */
const dispatchedKeys = `SELECT NEW.project_id AS project_id,NEW.id AS run_id,OLD.dispatched_by AS attempt_id WHERE OLD.dispatched_by IS NOT NULL
  UNION SELECT NEW.project_id,NEW.id,NEW.dispatched_by WHERE NEW.dispatched_by IS NOT NULL`;
/** A run's task or origin reclassifies every attempt of the run. */
const runKeys = 'SELECT project_id,run_id,attempt_id FROM agent_run_attempts WHERE project_id=NEW.project_id AND run_id=NEW.id';
export const SPEND_JSON_KEYS = jsonKeys(['project_id', 'run_id', 'attempt_id']);

/** The predicate of a due row at `floor`: a settled fact still counted after its claim left the window. */
const DUE = (floor: string) => `counted=1 AND live=0 AND claimed_at<=${floor}`;
/** A due page, oldest claim first. */
const expire = (floor: string, page: number | string) => `UPDATE attempt_spend SET counted=0 WHERE (project_id,run_id,attempt_id) IN (SELECT project_id,run_id,attempt_id FROM attempt_spend
  WHERE ${DUE(floor)} ORDER BY claimed_at LIMIT ${page})`;

/**
 * Money stays in the source's REAL dollars. Each rollup amount is a pair `(sum, carry)` kept by compensated
 * (Neumaier) addition, and each change is applied as an exact difference split into its rounded value and rounding
 * error, so the rollup stays within one rounding of a fresh sum of its facts however many changes it has seen.
 */
const MONEY = ['usd', 'live_usd', 'unconfirmed_estimate_usd'] as const;
const money = (row: string) => [`${row}.value`, `CASE WHEN ${row}.live=1 THEN ${row}.value ELSE 0 END`, `CASE WHEN ${unconfirmed(row)} THEN ${row}.estimate ELSE 0 END`];
const count = (row: string) => `CASE WHEN ${unconfirmed(row)} THEN 1 ELSE 0 END`;
/** The error of `a+b` in floating point (Knuth's TwoSum). */
const twoSumError = (a: string, b: string) => `(((${a})-((${a})+(${b})-((${a})+(${b})-(${a}))))+((${b})-((${a})+(${b})-(${a}))))`;
/** Neumaier's correction for adding `x` to the running `sum`. */
const neumaier = (sum: string, x: string) => `CASE WHEN abs(${sum})>=abs(${x}) THEN (${sum}-(${sum}+${x}))+${x} ELSE (${x}-(${sum}+${x}))+${sum} END`;

/** One upsert moving a rollup row by `plus - minus`; `plus`/`minus` are a counted fact's contributions or null. */
function rollup(key: string, plus: string | null, minus: string | null, where: string): string {
  const terms = (row: string | null) => row === null ? MONEY.map(() => '0') : money(row);
  const add = terms(plus), sub = terms(minus).map(value => `-(${value})`);
  const delta = MONEY.map((_, i) => `(${add[i]})+(${sub[i]})`);
  const carry = MONEY.map((_, i) => twoSumError(add[i]!, sub[i]!));
  const units = `${plus === null ? '0' : count(plus)}-${minus === null ? '0' : count(minus)}`;
  const columns = MONEY.flatMap(column => [column, `${column}_carry`]);
  return `INSERT INTO budget_totals(project_id,origin,${columns.join(',')},unconfirmed) SELECT ${key}.project_id,${key}.origin,
    ${MONEY.map((_, i) => `${delta[i]},${carry[i]}`).join(',')},${units} WHERE ${where}
    ON CONFLICT(project_id,origin) DO UPDATE SET ${MONEY.map(column => `${column}=${column}+excluded.${column},${column}_carry=${column}_carry+excluded.${column}_carry+${neumaier(column, `excluded.${column}`)}`).join(',')},
    unconfirmed=unconfirmed+excluded.unconfirmed`;
}

/** A fact that keeps its Project and origin moves its one rollup row by the difference. */
const SAME_ROLLUP = 'OLD.project_id=NEW.project_id AND OLD.origin=NEW.origin';

export interface SpendTrigger { name: string; table: string; sql: string }
/** Triggers in the order the schema step installs them. Their SQL is frozen in the step file. */
export function spendTriggers(): SpendTrigger[] {
  const worker = (row: string) => workerTaskSql(`${row}.task`);
  const runColumns = ['status', 'dispatched_by', 'cost_usd', 'cost_source'];
  const classColumns = ['task', 'origin'];
  const attemptColumns = ['claimed_at', 'estimate_usd', 'cost_usd', 'cost_source'];
  return [
    trigger('attempt_spend_add', 'attempt_spend', 'INSERT', [rollup('NEW', 'NEW', null, '1')], 'NEW.counted=1'),
    trigger('attempt_spend_remove', 'attempt_spend', 'DELETE', [rollup('OLD', null, 'OLD', '1')], 'OLD.counted=1'),
    trigger('attempt_spend_move', 'attempt_spend', 'UPDATE', [
      `${rollup('NEW', 'NEW', 'OLD', `${SAME_ROLLUP} AND NEW.counted=1 AND OLD.counted=1`)}`,
      `${rollup('NEW', 'NEW', null, `NEW.counted=1 AND NOT (${SAME_ROLLUP} AND OLD.counted=1)`)}`,
      `${rollup('OLD', null, 'OLD', `OLD.counted=1 AND NOT (${SAME_ROLLUP} AND NEW.counted=1)`)}`,
    ]),
    trigger('attempt_spend_attempt_insert', 'agent_run_attempts', 'INSERT', [...reconcileSpend(attemptKey('NEW'), 'NULL'),
      expire(`NEW.claimed_at-${BUDGET_WINDOW_MS}`, SPEND_EXPIRY_PAGE)]),
    trigger('attempt_spend_attempt_update', 'agent_run_attempts', `UPDATE OF ${attemptColumns.join(',')}`, reconcileSpend(attemptKey('NEW'), 'NULL'), changed(attemptColumns)),
    trigger('attempt_spend_attempt_delete', 'agent_run_attempts', 'DELETE',
      ['DELETE FROM attempt_spend WHERE project_id=OLD.project_id AND run_id=OLD.run_id AND attempt_id=OLD.attempt_id']),
    trigger('attempt_spend_run_update', 'agent_runs', `UPDATE OF ${runColumns.join(',')}`, reconcileSpend(dispatchedKeys, 'NULL'),
      `(${worker('OLD')} OR ${worker('NEW')}) AND (${changed(runColumns)})`),
    trigger('attempt_spend_run_reclassify', 'agent_runs', `UPDATE OF ${classColumns.join(',')}`, reconcileSpend(runKeys, 'NULL'),
      `(${worker('OLD')} OR ${worker('NEW')}) AND (${changed(classColumns)})`),
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
    `CREATE TABLE IF NOT EXISTS budget_totals(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),origin TEXT NOT NULL,
      ${MONEY.map(column => `${column} REAL NOT NULL DEFAULT 0,${column}_carry REAL NOT NULL DEFAULT 0`).join(',')},unconfirmed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,origin)) WITHOUT ROWID`,
    ...spendTriggers().map(trigger => trigger.sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${BUDGET_PROJECTION}','attempts',NOT EXISTS (SELECT 1 FROM agent_run_attempts)`,
  ];
}

const [spendRetract, spendUpsert] = reconcileSpend(SPEND_JSON_KEYS, '?2');
const catchupRetract = write<[string]>({ name: 'runs.spendPageRetract', sql: spendRetract! });
const catchupUpsert = write<[string, number]>({ name: 'runs.spendPageUpsert', sql: spendUpsert! });
/** Catch-up pages reconcile attempt keys against the expiry floor of the instant they run. */
export const BUDGET_CATCHUP = {
  projection: BUDGET_PROJECTION,
  phases: {
    attempts: {
      source: { table: 'agent_run_attempts', columns: ['project_id', 'run_id', 'attempt_id'] },
      reconcile: [
        catchupRetract,
        { bindAt: (keys: string, now: number) => catchupUpsert.bind(keys, now - BUDGET_WINDOW_MS) },
      ],
    },
  },
} as const satisfies CatchupFamily;

/** Catch-up readiness, as a SQL predicate: every catch-up phase of the projection is done. */
export const SPEND_CAUGHT_UP_SQL = `NOT EXISTS (SELECT 1 FROM projection_catchup WHERE projection='${BUDGET_PROJECTION}' AND done=0)`;

/** The first due rows at `floor`, oldest first: never more than one read page plus the row that proves a backlog. */
const duePage = (floor: string, extra = '') => `SELECT * FROM attempt_spend WHERE ${DUE(floor)}${extra} ORDER BY claimed_at LIMIT ${SPEND_DUE_READ_LIMIT + 1}`;

/**
 * Admission readiness at `floor`: catch-up is done and at most one read page of due rows is overdue. A larger backlog
 * waits for the expiry job instead of being summed.
 */
export const spendReadySql = (floor: string): string =>
  `(${SPEND_CAUGHT_UP_SQL} AND (SELECT COUNT(*) FROM (${duePage(floor)}))<=${SPEND_DUE_READ_LIMIT})`;

/**
 * Every read of a rollup amount is one SQL `SUM` over its rollup sums, their carries and the negated due rows. SQLite's
 * `SUM` is compensated on both stores, so the net is rounded once, as a recount of the counted facts would be.
 */
const parts = (where: '1', floor: string) => `SELECT project_id,origin,${MONEY.map(column => `${column} AS ${column}`).join(',')},unconfirmed FROM budget_totals WHERE ${where}
  UNION ALL SELECT project_id,origin,${MONEY.map(column => `${column}_carry`).join(',')},0 FROM budget_totals WHERE ${where}
  UNION ALL SELECT project_id,origin,-value,0,-(CASE WHEN ${unconfirmed('d')} THEN estimate ELSE 0 END),-(CASE WHEN ${unconfirmed('d')} THEN 1 ELSE 0 END) FROM (${duePage(floor)}) d`;
/**
 * Rolling spend in dollars at the floor slot: the rollup minus the due rows not yet retired.
 * Reads the Project/origin rollup rows and at most one page of due rows; callers pair it with `spendReadySql`.
 */
export function spentUsdSql(floor: string): string {
  return `(SELECT COALESCE(SUM(usd),0) FROM (${parts('1', floor)}))`;
}

/** Per-Project automatic spend shares the deployment snapshot's bounded expiry subtraction. */
export function projectSpendSql(floor: string): string {
  return `SELECT project_id AS projectId,COALESCE(SUM(usd),0) AS spent FROM (${parts('1', floor)}) WHERE origin='automatic' GROUP BY project_id`;
}
const projectSpend = read<[number], { projectId: string; spent: number }>({
  name: 'runs.projectSpend', sql: projectSpendSql('?1'),
});
export async function readProjectSpend(db: RelationalStore, now: number): Promise<Map<string, number>> {
  const [rows] = await readSet(db, projectSpend.bind(now - BUDGET_WINDOW_MS));
  return new Map(rows.map(row => [row.projectId, row.spent]));
}

export interface SpendTotals {
  origin: 'manual' | 'automatic'; usd: number; liveUsd: number; unconfirmed: number; unconfirmedEstimateUsd: number;
}
export interface LiveSpend { projectId: string; task: string; estimate: number; profileJson: string | null }

const totals = read<[number], SpendTotals>({ name: 'runs.spendTotals', sql: `SELECT origin,SUM(usd) AS usd,SUM(live_usd) AS liveUsd,SUM(unconfirmed) AS unconfirmed,
  SUM(unconfirmed_estimate_usd) AS unconfirmedEstimateUsd FROM (${parts('1', '?1')}) GROUP BY origin` });
const liveAutomatic = read<[], LiveSpend>({ name: 'runs.liveAutomaticSpend', sql: `SELECT s.project_id AS projectId,s.task,s.estimate,a.profile_json AS profileJson
  FROM attempt_spend s INDEXED BY idx_attempt_spend_live JOIN agent_run_attempts a ON a.project_id=s.project_id AND a.run_id=s.run_id AND a.attempt_id=s.attempt_id
  WHERE s.live=1 AND s.origin='automatic'` });
const readiness = read<[number], { ready: number }>({ name: 'runs.spendReady', sql: `SELECT ${spendReadySql('?1')} AS ready` });

/** One snapshot: per-origin totals at `now`, the live automatic exposure rows, and readiness. */
export async function readSpendSnapshot(db: RelationalStore, now: number): Promise<{ ready: boolean; totals: SpendTotals[]; live: LiveSpend[] }> {
  const [rows, live, ready] = await readSet(db, totals.bind(now - BUDGET_WINDOW_MS), liveAutomatic.bind(), readiness.bind(now - BUDGET_WINDOW_MS));
  return { ready: ready[0]?.ready === 1, totals: rows, live };
}

/** Whether accounting has caught up with attempt history and retired its due backlog at `now`. */
export async function spendReady(db: RelationalStore, now: number): Promise<boolean> {
  const [ready] = await readSet(db, readiness.bind(now - BUDGET_WINDOW_MS));
  return ready[0]?.ready === 1;
}

const expiryPage = write<[number], { project_id: string }>({ name: 'runs.spendExpire', sql: `${expire('?1', SPEND_EXPIRY_JOB_PAGE)} RETURNING project_id` });
const dueLeft = read<[number], { one: number }>({ name: 'runs.spendDueLeft', sql: `SELECT 1 AS one FROM attempt_spend WHERE ${DUE('?1')} LIMIT 1` });

/** The expiry job: retires due rows at `now` oldest first in bounded pages, asking for another wake while any remain. */
export async function expireSpend(db: RelationalStore, now: number, pages = 4): Promise<{ changed: number; more: boolean }> {
  let changed = 0;
  for (let page = 0; page < pages; page++) {
    const [retired] = await commit(db, expiryPage.bind(now - BUDGET_WINDOW_MS));
    changed += retired.results.length;
    if (retired.results.length < SPEND_EXPIRY_JOB_PAGE) return { changed, more: false };
  }
  const [left] = await readSet(db, dueLeft.bind(now - BUDGET_WINDOW_MS));
  return { changed, more: left.length > 0 };
}
