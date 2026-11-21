import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type BindValue } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { changed, jsonKeys, trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';
import { SPORE_READ_COLUMNS } from './browse.js';
import { sporeCuratedSql, sporeSourcesSql, UNIT_MEMBERS } from './origin-sql.js';

/**
 * Spore origins, maintained on write: one fact per spore holding its status, type, the instant it was written, whether
 * an editorial operation wrote it and from how many spores, and a rollup of those facts by status, type and origin.
 *
 * A fact is re-derived from the spore and its operation whenever a trigger or a catch-up page names its key, so a
 * replay never double-counts. A spore's own writes, the operation's members and a consolidation's events each name the
 * spores whose facts they move. A filtered list pages these facts in the order spores list in, and its total sums the
 * rollup.
 */
export const SPORE_ORIGIN_PROJECTION = 'spore_origins';
const SPORE_ORIGIN_PHASE = 'sporeOrigins';

const FACT_COLUMNS = ['status', 'observation_type', 'written_at', 'curated', 'written_from', 'band'] as const;

/**
 * Where a spore stands by how it came to be, as one indexed value: 0 saved, 1 written by an operation that recorded no
 * source, 2 written from one spore, 3 written from two or more. Every origin filter is a set of bands.
 */
const BANDS = { saved: 0, unsourced: 1, rewritten: 2, merged: 3 } as const;
const bandSql = (curated: string, sources: string): string =>
  `CASE WHEN ${curated} THEN CASE ${sources} WHEN 0 THEN ${BANDS.unsourced} WHEN 1 THEN ${BANDS.rewritten} ELSE ${BANDS.merged} END ELSE ${BANDS.saved} END`;
const COUNTED = ['status', 'observation_type', 'curated', 'written_from'] as const;

/** Re-derive the facts of the spore keys `keys` (columns `project_id,id`): a key whose spore is gone loses its fact. */
function reconcileOriginFacts(keys: string): string[] {
  return [
    `DELETE FROM spore_origin_facts WHERE (project_id,id) IN (SELECT project_id,id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM spores s WHERE s.project_id=spore_origin_facts.project_id AND s.id=spore_origin_facts.id)`,
    `INSERT INTO spore_origin_facts(project_id,id,${FACT_COLUMNS.join(',')})
      SELECT project_id,id,status,observation_type,written_at,curated,written_from,${bandSql('curated', 'written_from')} FROM (
        SELECT s.project_id,s.id,s.status,s.observation_type,s.created_at AS written_at,${sporeCuratedSql('s')} AS curated,${sporeSourcesSql('s')} AS written_from
        FROM (${keys}) key JOIN spores s ON s.project_id=key.project_id AND s.id=key.id) WHERE 1
      ON CONFLICT(project_id,id) DO UPDATE SET ${FACT_COLUMNS.map(c => `${c}=excluded.${c}`).join(',')}
        WHERE (${FACT_COLUMNS.map(c => `spore_origin_facts.${c}`).join(',')}) IS NOT (${FACT_COLUMNS.map(c => `excluded.${c}`).join(',')})`,
  ];
}

/** One catch-up page: the keys' facts re-derived inside the caller's commit. */
export const SPORE_ORIGIN_CATCHUP = {
  projection: SPORE_ORIGIN_PROJECTION,
  phases: { [SPORE_ORIGIN_PHASE]: { source: { table: 'spores', columns: ['project_id', 'id'] },
    reconcile: reconcileOriginFacts(jsonKeys(['project_id', 'id'])).map((sql, i) => write<[string]>({ name: `sporeOrigins.page${i}`, sql })) } },
} as const satisfies CatchupFamily;

/** The outputs of the operation `unit` of `project`, as spore keys. */
const outputsOf = (project: string, unit: string): string =>
  `SELECT project_id,spore_id AS id FROM spore_curation_unit_members INDEXED BY ${UNIT_MEMBERS} WHERE project_id=${project} AND unit_id=${unit} AND role='output'`;

/** The tables, indexes, triggers and catch-up seed of the origin facts, as one schema step freezes them. */
export function sporeOriginSchemaStatements(): string[] {
  const rowKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.id AS id`;
  const watched = ['project_id', 'id', 'status', 'observation_type', 'created_at'];
  const bump = (row: string, delta: 1 | -1) =>
    `INSERT INTO spore_origin_counts(project_id,${COUNTED.join(',')},n) VALUES(${row}.project_id,${COUNTED.map(c => `${row}.${c}`).join(',')},${delta})
      ON CONFLICT(project_id,${COUNTED.join(',')}) DO UPDATE SET n=n${delta === 1 ? '+1' : '-1'}`;
  return [
    `CREATE TABLE IF NOT EXISTS spore_origin_facts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),id TEXT NOT NULL,
      status TEXT NOT NULL,observation_type TEXT NOT NULL,written_at INTEGER NOT NULL,curated INTEGER NOT NULL,written_from INTEGER NOT NULL,
      band INTEGER NOT NULL,PRIMARY KEY(project_id,id)) WITHOUT ROWID`,
    ...Object.entries(EQUALITIES).map(([name, columns]) =>
      `CREATE INDEX IF NOT EXISTS ${INDEX_PREFIX}${name} ON spore_origin_facts(project_id,band,${columns.map(c => `${c},`).join('')}written_at DESC,id DESC)`),
    `CREATE TABLE IF NOT EXISTS spore_origin_counts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),status TEXT NOT NULL,observation_type TEXT NOT NULL,
      curated INTEGER NOT NULL,written_from INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(project_id,${COUNTED.join(',')})) WITHOUT ROWID`,
    trigger('spore_origin_insert', 'spores', 'INSERT', reconcileOriginFacts(rowKey('NEW'))).sql,
    trigger('spore_origin_update', 'spores', `UPDATE OF ${watched.join(',')}`, [...reconcileOriginFacts(rowKey('OLD')), ...reconcileOriginFacts(rowKey('NEW'))], changed(watched)).sql,
    trigger('spore_origin_delete', 'spores', 'DELETE', reconcileOriginFacts(rowKey('OLD'))).sql,
    trigger('spore_origin_member_insert', 'spore_curation_unit_members', 'INSERT', reconcileOriginFacts(outputsOf('NEW.project_id', 'NEW.unit_id'))).sql,
    trigger('spore_origin_member_update', 'spore_curation_unit_members', 'UPDATE OF project_id,unit_id,spore_id,role,event_ids',
      [...reconcileOriginFacts(`SELECT OLD.project_id AS project_id,OLD.spore_id AS id UNION ${outputsOf('OLD.project_id', 'OLD.unit_id')}`),
        ...reconcileOriginFacts(outputsOf('NEW.project_id', 'NEW.unit_id'))],
      changed(['project_id', 'unit_id', 'spore_id', 'role', 'event_ids'])).sql,
    trigger('spore_origin_member_delete', 'spore_curation_unit_members', 'DELETE',
      reconcileOriginFacts(`SELECT OLD.project_id AS project_id,OLD.spore_id AS id UNION ${outputsOf('OLD.project_id', 'OLD.unit_id')}`)).sql,
    trigger('spore_origin_consolidation', 'resolution_events', 'INSERT',
      reconcileOriginFacts('SELECT NEW.project_id AS project_id,NEW.new_spore_id AS id'), "NEW.action='consolidate' AND NEW.new_spore_id IS NOT NULL").sql,
    trigger('spore_origin_fact_insert', 'spore_origin_facts', 'INSERT', bump('NEW', 1)).sql,
    trigger('spore_origin_fact_update', 'spore_origin_facts', `UPDATE OF ${COUNTED.join(',')}`, [bump('OLD', -1), bump('NEW', 1)], changed(COUNTED)).sql,
    trigger('spore_origin_fact_delete', 'spore_origin_facts', 'DELETE', bump('OLD', -1)).sql,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${SPORE_ORIGIN_PROJECTION}','${SPORE_ORIGIN_PHASE}',NOT EXISTS(SELECT 1 FROM spores) ON CONFLICT DO NOTHING`,
  ];
}

/** A spore list narrowed by how its spores came to be, within one Project. */
export interface OriginFilter {
  /** Written by an editorial operation (`curated`) or saved as it is (`saved`). */
  origin?: 'curated' | 'saved';
  /** Written from at least this many spores, 1 or 2; implies `curated`. */
  minSources?: number;
  status?: string;
  observationType?: string;
}

/** The largest `min_sources` an origin list takes: it answers "written from more than one spore". */
export const MAX_MIN_SOURCES = 2;

/** The equality filters an origin page can name, each with the index that leads with them after the band. */
const EQUALITIES = { band: [], status: ['status'], type: ['observation_type'], statusType: ['status', 'observation_type'] } as const;
type Equality = keyof typeof EQUALITIES;
const INDEX_PREFIX = 'idx_spore_origin_facts_';

/** The bands a filter admits. */
function bandsOf(f: OriginFilter): number[] {
  if (f.origin === 'saved') return [BANDS.saved];
  if ((f.minSources ?? 0) >= 2) return [BANDS.merged];
  if ((f.minSources ?? 0) >= 1) return [BANDS.rewritten, BANDS.merged];
  return [BANDS.unsourced, BANDS.rewritten, BANDS.merged];
}

type Statement = ReturnType<typeof read<BindValue[], Record<string, unknown>>>;
const PAGES = new Map<string, { statement: Statement; slots: readonly string[] }>();

/**
 * One page statement per band set, equality filters and cursor: each band is its own walk of the index that leads with
 * the band and the filters named, in the order spores list in, at most one page long; the walks merge into one page. A
 * page after a cursor seeks past the cursor's instant rather than walking the pages before it.
 */
function pageOf(bands: readonly number[], equality: Equality, after: boolean) {
  const key = `${bands.join('')}${equality}${after ? 'After' : ''}`;
  const held = PAGES.get(key);
  if (held !== undefined) return held;
  const conditions = ['f.project_id={project}', ...EQUALITIES[equality].map(c => `f.${c}={${c === 'status' ? 'status' : 'type'}}`),
    ...(after ? ['f.written_at<={at} AND (f.written_at<{at} OR (f.written_at={at} AND f.id<{afterId}))'] : [])];
  const walk = (band: number) => `SELECT * FROM (SELECT f.project_id AS fact_project,f.id AS fact_id,f.written_at AS fact_at
    FROM spore_origin_facts f INDEXED BY ${INDEX_PREFIX}${equality} WHERE f.band=${band} AND ${conditions.join(' AND ')}
    ORDER BY f.written_at DESC,f.id DESC LIMIT {limit})`;
  const template = `SELECT spores.project_id AS projectId, ${SPORE_READ_COLUMNS}
    FROM (SELECT fact_project,fact_id FROM (${bands.map(walk).join(' UNION ALL ')}) ORDER BY fact_at DESC,fact_id DESC LIMIT {limit}) page
    CROSS JOIN spores ON spores.project_id=page.fact_project AND spores.id=page.fact_id
    ORDER BY spores.created_at DESC,spores.id DESC`;
  const slots: string[] = [];
  const sql = template.replace(/\{([a-zA-Z]+)\}/g, (_, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `?${slots.indexOf(slot) + 1}`;
  });
  const made = { statement: read<BindValue[], Record<string, unknown>>({ name: `sporeOrigins.page${key}`, sql }), slots };
  PAGES.set(key, made);
  return made;
}

const ready = read<[], { done: number }>({ name: 'sporeOrigins.ready',
  sql: `SELECT done FROM projection_catchup WHERE projection='${SPORE_ORIGIN_PROJECTION}' AND phase='${SPORE_ORIGIN_PHASE}'` });
const total = read<[project: string, curated: number, minSources: number, status: string | null, type: string | null], { n: number }>({ name: 'sporeOrigins.total',
  sql: `SELECT COALESCE(SUM(n),0) AS n FROM spore_origin_counts WHERE project_id=?1 AND curated=?2 AND written_from>=?3
    AND (?4 IS NULL OR status=?4) AND (?5 IS NULL OR observation_type=?5)` });

/**
 * One page of a Project's spores narrowed by origin, newest first with the id breaking a tie, at most `limit` + 1 rows,
 * and how many the filter admits; `building` while existing spores' origins are still being derived, when no page is
 * read. A page reads at most a page of facts for each band the filter admits, through an index led by its filters.
 */
export async function readOriginPage(db: RelationalStore, request: {
  projectId: string; filter: OriginFilter; after: { createdAt: number; id: string } | null; limit: number;
}): Promise<{ state: 'building' } | { state: 'ready'; rows: Record<string, unknown>[]; total: number }> {
  const { projectId, filter: f, after, limit } = request;
  const curated = f.origin === 'saved' ? 0 : 1;
  const minSources = f.minSources ?? 0;
  const equality: Equality = f.status !== undefined ? (f.observationType !== undefined ? 'statusType' : 'status') : f.observationType !== undefined ? 'type' : 'band';
  const { statement, slots } = pageOf(bandsOf(f), equality, after !== null);
  const values: Record<string, BindValue> = { project: projectId, status: f.status ?? null, type: f.observationType ?? null,
    at: after?.createdAt ?? null, afterId: after?.id ?? null, limit: limit + 1 };
  const [done, rows, counted] = await readSet(db, ready.bind(), statement.bind(...slots.map(slot => values[slot]!)),
    total.bind(projectId, curated, minSources, f.status ?? null, f.observationType ?? null));
  if (done[0]?.done !== 1) return { state: 'building' };
  return { state: 'ready', rows, total: Number(counted[0]?.n ?? 0) };
}
