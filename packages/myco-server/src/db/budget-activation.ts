import { IN_FLIGHT_RUN_STATUSES } from './run-statuses.js';
import type { RelationalStore } from '../core/adapters.js';

export const BUDGET_ENABLED = 'budget_enabled_at';
export const BUDGET_QUEUE_OPENED_AT = 'budget_queue_opened_at';
export const BUDGET_QUEUE_OPENED_SQL = `COALESCE((SELECT value FROM schema_meta WHERE key='${BUDGET_QUEUE_OPENED_AT}'),(SELECT value FROM schema_meta WHERE key='${BUDGET_ENABLED}'))`;

/** The queue's activation instant, including the stamp of an already active governor. */
export async function budgetQueueOpenedAt(db: RelationalStore): Promise<string | null> {
  const row = await db.prepare(`SELECT ${BUDGET_QUEUE_OPENED_SQL} AS at`).first<{ at: string | null }>();
  return row?.at ?? null;
}

export const BUDGET_REFUSAL = 'budget_activation_refusal';
const BUDGET_INDEX_ROWS = 'budget_index_rows';
const BUDGET_STARTED = 'budget_activation_started_at';
export const BUDGET_INDEX_ROW_LIMIT = 100_000;
export const BUDGET_INDEXES = [
  { name: 'idx_attempts_claimed', table: 'agent_run_attempts', columns: 'claimed_at', suffix: '' },
  { name: 'idx_attempts_settled', table: 'agent_run_attempts', columns: 'settled_seq', suffix: ' WHERE profile_json IS NOT NULL AND cost_usd IS NOT NULL' },
  { name: 'idx_agent_runs_queue_head', table: 'agent_runs', columns: 'task,origin,queued_at,id', suffix: " WHERE status='queued' AND dispatched_by IS NULL" },
] as const;
export interface BudgetActivation { active: boolean; reason: string | null }
export type BudgetCompletion = BudgetActivation | { active: null; reason: string };
export const budgetCompletionMessage = (result: BudgetCompletion): string | null => result.active === true ? null
  : `${result.active === null ? 'Budget governor state not verified' : 'Budget governor inactive'}: ${result.reason}. Automatic work requires an active validated governor; capture and manual work remain available.`;
export interface BudgetMigrationStatement { sql: string; read: boolean }
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const normalize = (sql: string): string => sql.toLowerCase().replace(/\bif not exists\b|[\s"`\[\]]/g, '');
const indexSql = (index: typeof BUDGET_INDEXES[number]): string => `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}(${index.columns})${index.suffix}`;
class BudgetInvariantError extends Error {}

/** The exact catalogue row ids verified by activation, scoped to this database. */
function indexWitness(rows: Record<string, unknown>[]): string {
  const ids = BUDGET_INDEXES.map(index => rows.find(row => row.name === index.name)?.id);
  if (!ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) throw new Error('Budget index catalogue identities are unavailable');
  return `INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${BUDGET_INDEX_ROWS}',${literal(JSON.stringify(ids))})`;
}
const activationStartedSql=(now:number):string=>`INSERT OR IGNORE INTO schema_meta(key,value)
  SELECT '${BUDGET_STARTED}',COALESCE((SELECT value FROM schema_meta WHERE key='${BUDGET_ENABLED}'),${literal(String(now))})`;

/** Operator-owned index preparation; activation is published after catalogue verification. */
export function* budgetMigration(now: number): Generator<BudgetMigrationStatement, BudgetCompletion, Record<string, unknown>[]> {
  let enabled: boolean | undefined;
  try {
  const stamps = yield { sql: `SELECT key,value FROM schema_meta WHERE key IN ('${BUDGET_ENABLED}','${BUDGET_REFUSAL}')`, read: true };
  enabled = stamps.some(row => row.key === BUDGET_ENABLED);
  const indexes = yield { sql: `SELECT name,sql,rowid AS id FROM sqlite_master WHERE type='index' AND name IN (${BUDGET_INDEXES.map(index => literal(index.name)).join(',')})`, read: true };
  const missing = BUDGET_INDEXES.filter(index => !indexes.some(row => row.name === index.name));
  const wrong = BUDGET_INDEXES.find(index => indexes.some(row => row.name === index.name && normalize(String(row.sql)) !== normalize(indexSql(index))));
  if (enabled && (missing.length > 0 || wrong !== undefined)) throw new BudgetInvariantError('Active budget indexes do not match the admitted schema');
  if (enabled) { yield {sql:indexWitness(indexes),read:false}; return { active: true, reason: null }; }
  yield {sql:activationStartedSql(now),read:false};
  let refusal = wrong === undefined ? null : `Budget index ${wrong.name} has an unexpected definition`;
  if (refusal === null && missing.length > 0) {
    for (const table of new Set(BUDGET_INDEXES.map(index=>index.table))) {
      const rows = yield { sql: `SELECT COUNT(*) AS n FROM ${table}`, read: true };
      const value=rows[0]?.n;
      const count=typeof value==='number'||(typeof value==='string'&&value.trim()!=='')?Number(value):NaN;
      if (rows.length!==1||!Number.isSafeInteger(count)||count<0) throw new Error(`${table}: budget preflight returned no valid count`);
      if (count > BUDGET_INDEX_ROW_LIMIT) refusal = `${table}: ${count} rows exceeds index preflight threshold ${BUDGET_INDEX_ROW_LIMIT}; review agent.run_retention_days, allow terminal-run retention to finish, then retry myco server update`;
    }
  }
  if (refusal !== null) {
    yield { sql: `INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${BUDGET_REFUSAL}',${literal(refusal)})`, read: false };
    return { active: false, reason: refusal };
  }
  for (const index of missing) yield { sql: indexSql(index), read: false };
  const verified = yield { sql: `SELECT name,sql,rowid AS id FROM sqlite_master WHERE type='index' AND name IN (${BUDGET_INDEXES.map(index => literal(index.name)).join(',')})`, read: true };
  if (!BUDGET_INDEXES.every(index => verified.some(row => row.name === index.name && normalize(String(row.sql)) === normalize(indexSql(index))))) throw new Error('Budget index verification failed');
  yield {sql:indexWitness(verified),read:false};
  const origins = yield { sql: `SELECT 1 AS missing FROM agent_runs INDEXED BY idx_agent_runs_task_live WHERE ${IN_FLIGHT_RUN_STATUSES} AND origin IS NULL LIMIT 1`, read: true };
  if (origins.length > 0) throw new Error('Budget activation requires classified live run origins');
  yield { sql: `DELETE FROM schema_meta WHERE key='${BUDGET_REFUSAL}'`, read: false };
  yield { sql: `INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${BUDGET_QUEUE_OPENED_AT}',${literal(String(now))})`, read: false };
  enabled=undefined;
  yield { sql: `INSERT OR IGNORE INTO schema_meta(key,value) SELECT '${BUDGET_ENABLED}',value FROM schema_meta WHERE key='${BUDGET_STARTED}'`, read: false };
  enabled=true;
  return { active: true, reason: null };
  } catch(error) {
    if(error instanceof BudgetInvariantError)throw error;
    if(enabled!==false)return {active:null,reason:error instanceof Error?error.message:String(error)};
    const reason=`Budget activation preflight refused: ${error instanceof Error?error.message:String(error)}`;
    yield {sql:activationStartedSql(now),read:false};
    yield {sql:`DELETE FROM schema_meta WHERE key='${BUDGET_ENABLED}'`,read:false};
    yield {sql:`INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${BUDGET_REFUSAL}',${literal(reason)})`,read:false};
    return {active:false,reason};
  }
}

export async function completeBudgetMigration(db: RelationalStore, now: number): Promise<BudgetCompletion> {
  const migration = budgetMigration(now);
  let next = migration.next();
  while (!next.done) {
    const step = next.value;
    let rows:Record<string,unknown>[];
    try {rows=step.read ? (await db.prepare(step.sql).all<Record<string, unknown>>()).results : (await db.prepare(step.sql).run(), []);}
    catch(error) {next=migration.throw(error);continue;}
    next = migration.next(rows);
  }
  return next.value;
}

/** The inactive reason is operator-visible; active state requires every prepared index. */
export async function budgetActivation(db: RelationalStore): Promise<BudgetActivation> {
  const row = await db.prepare(`SELECT EXISTS(SELECT 1 FROM schema_meta WHERE key='${BUDGET_ENABLED}') AS enabled,
    (SELECT value FROM schema_meta WHERE key='${BUDGET_REFUSAL}') AS reason,
    (SELECT value FROM schema_meta WHERE key='${BUDGET_INDEX_ROWS}') AS witness`).first<{ enabled: number; reason: string | null; witness: string | null }>();
  if (row === null) throw new Error('Budget activation state is unavailable');
  if (!row.enabled) return { active: false, reason: row.reason ?? 'Budget index preparation has not completed' };
  const ids: unknown = row.witness === null ? null : JSON.parse(row.witness);
  const witnessed = Array.isArray(ids) && ids.length === BUDGET_INDEXES.length && ids.every(id => Number.isSafeInteger(id) && id > 0);
  const read = async (where: string, params: unknown[] = []) => (await db.prepare(`SELECT name,sql FROM sqlite_master WHERE ${where}`).bind(...params).all<{name:string;sql:string}>()).results;
  let indexes = witnessed ? await read(`rowid IN (${ids.map(() => '?').join(',')})`, ids) : [];
  const valid = () => BUDGET_INDEXES.every(index => indexes.some(found => found.name===index.name && normalize(found.sql)===normalize(indexSql(index))));
  if (!valid()) indexes = await read(`type='index' AND name IN (${BUDGET_INDEXES.map(index => literal(index.name)).join(',')})`);
  if (!valid()) throw new Error('Active budget indexes are missing or inconsistent');
  return { active: true, reason: null };
}
