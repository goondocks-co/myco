import { USER_AGENT_ID } from '../../constants.js';
import type { RelationalStore } from '../../core/adapters.js';
import type { ProjectSet } from '../../read/scope.js';
import { read, readSet, write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { changed, jsonKeys, trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * Spore totals by structured dimension, maintained on write and never recounted.
 *
 * Each spore contributes exactly one row to `spore_count_facts`, re-derived from the spore itself whenever a trigger or
 * a catch-up page names its key, so replaying a key or interleaving catch-up with live writes never double-counts. The
 * fact freezes who the author is (`run`, `member`, `imported`, `grant`, or `''` for none) at the moment it is derived,
 * so a later removal subtracts exactly what its addition added. Triggers on the fact move three rollups by `-old +new`:
 * `spore_counts` per Project, `spore_session_counts` per session and UTC day, and `spore_daily` per Project and UTC day
 * of `created_at`.
 */
export const SPORE_COUNT_PROJECTION = 'spore_counts';
export const SPORE_COUNT_PHASE = 'spores';
export const SPORE_DAY_MS = 86_400_000;

const dayOf = (time: string) => `CAST((${time} - ((${time} % ${SPORE_DAY_MS} + ${SPORE_DAY_MS}) % ${SPORE_DAY_MS})) / ${SPORE_DAY_MS} AS INTEGER)`;

/** Who a spore's author is, as reads have always answered it (`core/spores.ts`), with `''` for a spore naming none. */
const authorKind = (s: string) => `CASE WHEN ${s}.author IS NULL THEN ''
  WHEN EXISTS (SELECT 1 FROM members m WHERE m.id = ${s}.author) THEN CASE WHEN ${s}.agent_id = '${USER_AGENT_ID}' THEN 'member' ELSE 'imported' END
  WHEN EXISTS (SELECT 1 FROM external_grants g WHERE g.id = ${s}.author) THEN 'grant'
  ELSE 'run' END`;

const FACT_COLUMNS = ['status', 'observation_type', 'author_kind', 'session_id', 'day'] as const;

/** Re-derive the facts of the spore keys `keys` (columns `project_id,id`): a key whose spore is gone loses its fact. */
export function reconcileSporeFacts(keys: string): string[] {
  return [
    `DELETE FROM spore_count_facts WHERE (project_id,id) IN (SELECT project_id,id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM spores s WHERE s.project_id=spore_count_facts.project_id AND s.id=spore_count_facts.id)`,
    `INSERT INTO spore_count_facts(project_id,id,${FACT_COLUMNS.join(',')})
      SELECT s.project_id,s.id,s.status,s.observation_type,${authorKind('s')},s.session_id,${dayOf('s.created_at')}
      FROM (${keys}) key JOIN spores s ON s.project_id=key.project_id AND s.id=key.id WHERE 1
      ON CONFLICT(project_id,id) DO UPDATE SET ${FACT_COLUMNS.map(c => `${c}=excluded.${c}`).join(',')}
        WHERE (${FACT_COLUMNS.map(c => `spore_count_facts.${c}`).join(',')}) IS NOT (${FACT_COLUMNS.map(c => `excluded.${c}`).join(',')})`,
  ];
}

/** The spore keys of one catch-up page, carried as one JSON array of `[project_id, id]`. */
const PAGE_KEYS = jsonKeys(['project_id', 'id']);

/** One catch-up page: the keys' facts re-derived inside the caller's commit. */
export const SPORE_COUNT_CATCHUP = {
  projection: SPORE_COUNT_PROJECTION,
  phases: { [SPORE_COUNT_PHASE]: { source: { table: 'spores', columns: ['project_id', 'id'] },
    reconcile: reconcileSporeFacts(PAGE_KEYS).map((sql, i) => write<[string]>({ name: `sporeCounts.page${i}`, sql })) } },
} as const satisfies CatchupFamily;

/** The derived tables, their triggers and the catch-up seed, as one schema step freezes them. */
export function sporeCountSchemaStatements(): string[] {
  const rowKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.id AS id`;
  const watched = ['project_id', 'id', 'status', 'observation_type', 'session_id', 'author', 'agent_id', 'created_at'];
  const bump = (row: string, delta: 1 | -1) => {
    const sign = delta === 1 ? '+1' : '-1';
    return [
      `INSERT INTO spore_counts(project_id,status,observation_type,author_kind,n) VALUES(${row}.project_id,${row}.status,${row}.observation_type,${row}.author_kind,${delta})
        ON CONFLICT(project_id,status,observation_type,author_kind) DO UPDATE SET n=n${sign}`,
      `INSERT INTO spore_daily(project_id,day,status,observation_type,author_kind,n) VALUES(${row}.project_id,${row}.day,${row}.status,${row}.observation_type,${row}.author_kind,${delta})
        ON CONFLICT(project_id,day,status,observation_type,author_kind) DO UPDATE SET n=n${sign}`,
      `INSERT INTO spore_session_counts(project_id,session_id,day,status,observation_type,n)
        SELECT ${row}.project_id,${row}.session_id,${row}.day,${row}.status,${row}.observation_type,${delta} WHERE ${row}.session_id IS NOT NULL
        ON CONFLICT(project_id,session_id,day,status,observation_type) DO UPDATE SET n=n${sign}`,
    ];
  };
  return [
    `CREATE TABLE IF NOT EXISTS spore_count_facts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),id TEXT NOT NULL,
      status TEXT NOT NULL,observation_type TEXT NOT NULL,author_kind TEXT NOT NULL,session_id TEXT,day INTEGER NOT NULL,
      PRIMARY KEY(project_id,id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS spore_counts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),status TEXT NOT NULL,observation_type TEXT NOT NULL,
      author_kind TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(project_id,status,observation_type,author_kind)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS spore_session_counts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,day INTEGER NOT NULL,
      status TEXT NOT NULL,observation_type TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(project_id,session_id,day,status,observation_type)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS spore_daily(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),day INTEGER NOT NULL,status TEXT NOT NULL,
      observation_type TEXT NOT NULL,author_kind TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(project_id,day,status,observation_type,author_kind)) WITHOUT ROWID`,
    trigger('spore_count_insert', 'spores', 'INSERT', reconcileSporeFacts(rowKey('NEW'))).sql,
    trigger('spore_count_update', 'spores', `UPDATE OF ${watched.join(',')}`, [...reconcileSporeFacts(rowKey('OLD')), ...reconcileSporeFacts(rowKey('NEW'))], changed(watched)).sql,
    trigger('spore_count_delete', 'spores', 'DELETE', reconcileSporeFacts(rowKey('OLD'))).sql,
    trigger('spore_count_fact_insert', 'spore_count_facts', 'INSERT', bump('NEW', 1)).sql,
    trigger('spore_count_fact_update', 'spore_count_facts', `UPDATE OF ${FACT_COLUMNS.join(',')}`, [...bump('OLD', -1), ...bump('NEW', 1)], changed(FACT_COLUMNS)).sql,
    trigger('spore_count_fact_delete', 'spore_count_facts', 'DELETE', bump('OLD', -1)).sql,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${SPORE_COUNT_PROJECTION}','${SPORE_COUNT_PHASE}',NOT EXISTS(SELECT 1 FROM spores)`,
  ];
}

/** The structured filters a counter answers: anything else a list names has no total. */
export interface SporeCountFilters {
  status?: string;
  observationType?: string;
  sessionId?: string;
  /** First UTC day counted (epoch days), inclusive. */
  fromDay?: number;
  /** UTC day counting stops before (epoch days), exclusive. */
  toDay?: number;
}

type Reach = 'project' | 'all' | 'named';
type Source = 'counts' | 'session' | 'daily';
const REACHES = ['project', 'all', 'named'] as const;
const SOURCES = ['counts', 'session', 'daily'] as const;
const TABLE: Record<Source, string> = { counts: 'spore_counts', session: 'spore_session_counts', daily: 'spore_daily' };

/** `?1` the Project or the named set as JSON, `?2` status, `?3` type, `?4` session, `?5`/`?6` the day range. */
function where(reach: Reach, source: Source): string {
  const projects = reach === 'project' ? 'project_id=?1'
    : reach === 'all' ? 'project_id IN (SELECT project_id FROM projects WHERE archived_at IS NULL) AND ?1 IS NULL'
    : 'project_id IN (SELECT value FROM json_each(?1))';
  return [projects, '(?2 IS NULL OR status=?2)', '(?3 IS NULL OR observation_type=?3)',
    source === 'session' ? 'session_id=?4' : '?4 IS NULL',
    source === 'counts' ? '?5 IS NULL AND ?6 IS NULL' : 'day>=?5 AND day<?6'].join(' AND ');
}

type CountParams = [string | null, string | null, string | null, string | null, number | null, number | null];
const define = <Row>(kind: string, sql: (reach: Reach, source: Source) => string) =>
  Object.fromEntries(REACHES.flatMap(reach => SOURCES.map(source => [`${reach}:${source}`,
    read<CountParams, Row>({ name: `sporeCounts.${kind}${reach[0]!.toUpperCase()}${reach.slice(1)}${source[0]!.toUpperCase()}${source.slice(1)}`, sql: sql(reach, source) })])));
const TOTALS = define<{ n: number }>('total', (reach, source) => `SELECT COALESCE(SUM(n),0) AS n FROM ${TABLE[source]} WHERE ${where(reach, source)}`);
const BY_TYPE = define<{ k: string; n: number }>('byType', (reach, source) =>
  `SELECT observation_type AS k,SUM(n) AS n FROM ${TABLE[source]} WHERE ${where(reach, source)} GROUP BY observation_type HAVING SUM(n)<>0`);
const BY_PROJECT = define<{ k: string; n: number }>('byProject', (reach, source) =>
  `SELECT project_id AS k,SUM(n) AS n FROM ${TABLE[source]} WHERE ${where(reach, source)} GROUP BY project_id HAVING SUM(n)<>0`);
const READY = read<[string, string], { done: number }>({ name: 'sporeCounts.ready', sql: 'SELECT done FROM projection_catchup WHERE projection=?1 AND phase=?2' });

const sourceOf = (f: SporeCountFilters): Source =>
  f.sessionId !== undefined ? 'session' : f.fromDay !== undefined || f.toDay !== undefined ? 'daily' : 'counts';
const reachOf = (scope: { projectId: string } | ProjectSet): { reach: Reach; first: string | null } =>
  'projectId' in scope ? { reach: 'project', first: scope.projectId }
    : scope.all ? { reach: 'all', first: null } : { reach: 'named', first: JSON.stringify(scope.projectIds) };
const params = (first: string | null, f: SporeCountFilters, source: Source, withType = true): CountParams => [
  first, f.status ?? null, withType ? f.observationType ?? null : null, f.sessionId ?? null,
  source === 'counts' ? null : f.fromDay ?? Number.MIN_SAFE_INTEGER, source === 'counts' ? null : f.toDay ?? Number.MAX_SAFE_INTEGER];

export type CountAnswer<T> = { state: 'ready'; value: T } | { state: 'building' };

/** How many spores the filters admit, read from the counters; `building` until existing spores have been counted. */
export async function sporeTotal(db: RelationalStore, scope: { projectId: string } | ProjectSet, f: SporeCountFilters): Promise<CountAnswer<number>> {
  const source = sourceOf(f);
  const { reach, first } = reachOf(scope);
  const [ready, total] = await readSet(db, READY.bind(SPORE_COUNT_PROJECTION, SPORE_COUNT_PHASE), TOTALS[`${reach}:${source}`]!.bind(...params(first, f, source)));
  return ready[0]?.done === 1 ? { state: 'ready', value: Number(total[0]?.n ?? 0) } : { state: 'building' };
}

export interface SporeFacetCounts { type: Record<string, number>; project: Record<string, number> }

/**
 * The total and both facets beside a read across Projects, in one read set. Each facet drops its own filter: types count
 * over the named Projects whatever type is chosen, and Projects over every visible Project whatever Projects are named.
 */
export async function sporeTotalAndFacets(db: RelationalStore, set: ProjectSet, f: SporeCountFilters):
  Promise<CountAnswer<{ total: number; facets: SporeFacetCounts }>> {
  const source = sourceOf(f);
  const { reach, first } = reachOf(set);
  const [ready, total, types, projects] = await readSet(db,
    READY.bind(SPORE_COUNT_PROJECTION, SPORE_COUNT_PHASE),
    TOTALS[`${reach}:${source}`]!.bind(...params(first, f, source)),
    BY_TYPE[`${reach}:${source}`]!.bind(...params(first, f, source, false)),
    BY_PROJECT[`all:${source}`]!.bind(...params(null, f, source)));
  if (ready[0]?.done !== 1) return { state: 'building' };
  const tally = (rows: readonly { k: string; n: number }[]) => Object.fromEntries(rows.map(r => [r.k, Number(r.n)]));
  return { state: 'ready', value: { total: Number(total[0]?.n ?? 0), facets: { type: tally(types), project: tally(projects) } } };
}

/**
 * A range of instants widened to the whole UTC days it touches: the first instant of the day `from` falls in, and the
 * first instant after the day before `to` (exclusive). Lists and their totals both read the widened range.
 */
export function utcDays(from: number | undefined, to: number | undefined): { fromDay?: number; toDay?: number } {
  return {
    ...(from === undefined ? {} : { fromDay: Math.floor(from / SPORE_DAY_MS) }),
    ...(to === undefined ? {} : { toDay: Math.ceil(to / SPORE_DAY_MS) }),
  };
}

/** Whether a Project holds at least `floor` active spores: a bounded probe that reads at most `floor` index entries. */
const ACTIVE_AT_LEAST = read<[string, number], { n: number }>({ name: 'sporeCounts.activeAtLeast',
  sql: "SELECT COUNT(*) AS n FROM (SELECT 1 FROM spores INDEXED BY idx_spores_status WHERE project_id=?1 AND status='active' LIMIT ?2)" });
export async function activeSporesAtLeast(db: RelationalStore, projectId: string, floor: number): Promise<boolean> {
  const [rows] = await readSet(db, ACTIVE_AT_LEAST.bind(projectId, floor));
  return Number(rows[0]?.n ?? 0) >= floor;
}

