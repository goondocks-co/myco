import type { RelationalStore } from '../../core/adapters.js';
import type { ProjectSet } from '../../read/scope.js';
import { read, readSet, write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import type { CountAnswer } from '../spores/counts.js';

/**
 * Plan totals by status, maintained on write and never recounted. Each plan contributes one `plan_count_facts` row,
 * re-derived from the plan whenever a trigger or a catch-up page names its key; triggers on the fact move
 * `plan_counts` by `-old +new`.
 */
export const PLAN_COUNT_PROJECTION = 'plan_counts';
export const PLAN_COUNT_PHASE = 'plans';

/** Re-derive the facts of the plan keys `keys` (columns `project_id,plan_key`): a key whose plan is gone loses its fact. */
export function reconcilePlanFacts(keys: string): string[] {
  return [
    `DELETE FROM plan_count_facts WHERE (project_id,plan_key) IN (SELECT project_id,plan_key FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.project_id=plan_count_facts.project_id AND p.plan_key=plan_count_facts.plan_key)`,
    `INSERT INTO plan_count_facts(project_id,plan_key,status)
      SELECT p.project_id,p.plan_key,p.status FROM (${keys}) key JOIN plans p ON p.project_id=key.project_id AND p.plan_key=key.plan_key WHERE 1
      ON CONFLICT(project_id,plan_key) DO UPDATE SET status=excluded.status WHERE plan_count_facts.status IS NOT excluded.status`,
  ];
}

const PAGE_KEYS = `SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS plan_key FROM json_each(?1)`;

/** One catch-up page: the keys' facts re-derived inside the caller's commit. */
export const PLAN_COUNT_RECONCILE = reconcilePlanFacts(PAGE_KEYS)
  .map((sql, i) => write<[string]>({ name: `planCounts.page${i}`, sql }));

/** The derived tables, their triggers and the catch-up seed, as one schema step freezes them. */
export function planCountSchemaStatements(): string[] {
  const rowKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.plan_key AS plan_key`;
  const watched = ['project_id', 'plan_key', 'status'];
  const changed = watched.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  const trigger = (name: string, table: string, event: string, when: string | null, body: readonly string[]) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when === null ? '' : ` WHEN ${when}`} BEGIN ${body.join('; ')}; END`;
  const bump = (row: string, delta: 1 | -1) => `INSERT INTO plan_counts(project_id,status,n) VALUES(${row}.project_id,${row}.status,${delta})
      ON CONFLICT(project_id,status) DO UPDATE SET n=n${delta === 1 ? '+1' : '-1'}`;
  return [
    `CREATE TABLE IF NOT EXISTS plan_count_facts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),plan_key TEXT NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY(project_id,plan_key)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS plan_counts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),status TEXT NOT NULL,n INTEGER NOT NULL,
      PRIMARY KEY(project_id,status)) WITHOUT ROWID`,
    trigger('plan_count_insert', 'plans', 'INSERT', null, reconcilePlanFacts(rowKey('NEW'))),
    trigger('plan_count_update', 'plans', `UPDATE OF ${watched.join(',')}`, changed, [...reconcilePlanFacts(rowKey('OLD')), ...reconcilePlanFacts(rowKey('NEW'))]),
    trigger('plan_count_delete', 'plans', 'DELETE', null, reconcilePlanFacts(rowKey('OLD'))),
    trigger('plan_count_fact_insert', 'plan_count_facts', 'INSERT', null, [bump('NEW', 1)]),
    trigger('plan_count_fact_update', 'plan_count_facts', 'UPDATE OF status', 'OLD.status IS NOT NEW.status', [bump('OLD', -1), bump('NEW', 1)]),
    trigger('plan_count_fact_delete', 'plan_count_facts', 'DELETE', null, [bump('OLD', -1)]),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${PLAN_COUNT_PROJECTION}','${PLAN_COUNT_PHASE}',NOT EXISTS(SELECT 1 FROM plans)`,
  ];
}

const READY = read<[string, string], { done: number }>({ name: 'planCounts.ready', sql: 'SELECT done FROM projection_catchup WHERE projection=?1 AND phase=?2' });
const BY_STATUS = {
  project: read<[string], { status: string; n: number }>({ name: 'planCounts.byStatusProject',
    sql: 'SELECT status,n FROM plan_counts WHERE project_id=?1 AND n<>0' }),
  all: read<[], { status: string; n: number }>({ name: 'planCounts.byStatusAll',
    sql: 'SELECT status,SUM(n) AS n FROM plan_counts WHERE project_id IN (SELECT project_id FROM projects WHERE archived_at IS NULL) GROUP BY status HAVING SUM(n)<>0' }),
  named: read<[string], { status: string; n: number }>({ name: 'planCounts.byStatusNamed',
    sql: 'SELECT status,SUM(n) AS n FROM plan_counts WHERE project_id IN (SELECT value FROM json_each(?1)) GROUP BY status HAVING SUM(n)<>0' }),
};

/** How many plans of each status the Projects hold, from the counters; `building` until existing plans have been counted. */
export async function planStatusTotals(db: RelationalStore, scope: { projectId: string } | ProjectSet): Promise<CountAnswer<Record<string, number>>> {
  const ready = READY.bind(PLAN_COUNT_PROJECTION, PLAN_COUNT_PHASE);
  const counts = 'projectId' in scope ? BY_STATUS.project.bind(scope.projectId)
    : scope.all ? BY_STATUS.all.bind() : BY_STATUS.named.bind(JSON.stringify(scope.projectIds));
  const [held, rows] = await readSet(db, ready, counts);
  if (held[0]?.done !== 1) return { state: 'building' };
  return { state: 'ready', value: Object.fromEntries(rows.map(r => [r.status, Number(r.n)])) };
}
