import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { changed, jsonKeys, trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';
import { LISTED_SUCCESSORS, SPORE_READ_COLUMNS } from './browse.js';
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

const FACT_COLUMNS = ['status', 'observation_type', 'written_at', 'curated', 'written_from'] as const;
const COUNTED = ['status', 'observation_type', 'curated', 'written_from'] as const;

/** Re-derive the facts of the spore keys `keys` (columns `project_id,id`): a key whose spore is gone loses its fact. */
function reconcileOriginFacts(keys: string): string[] {
  return [
    `DELETE FROM spore_origin_facts WHERE (project_id,id) IN (SELECT project_id,id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM spores s WHERE s.project_id=spore_origin_facts.project_id AND s.id=spore_origin_facts.id)`,
    `INSERT INTO spore_origin_facts(project_id,id,${FACT_COLUMNS.join(',')})
      SELECT s.project_id,s.id,s.status,s.observation_type,s.created_at,${sporeCuratedSql('s')},${sporeSourcesSql('s')}
      FROM (${keys}) key JOIN spores s ON s.project_id=key.project_id AND s.id=key.id WHERE 1
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
      PRIMARY KEY(project_id,id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_spore_origin_facts_page ON spore_origin_facts(project_id,curated,written_at DESC,id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_spore_origin_facts_merged ON spore_origin_facts(project_id,written_at DESC,id DESC) WHERE written_from>=2',
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
  /** Written from at least this many spores; implies `curated`. */
  minSources?: number;
  status?: string;
  observationType?: string;
}

type Walk = 'curated' | 'saved' | 'merged';
/** The index a page walks: spores written from two or more, or one origin, each in the order spores list in. */
const walkOf = (f: OriginFilter): Walk => (f.minSources ?? 0) >= 2 ? 'merged' : f.origin === 'saved' ? 'saved' : 'curated';
const WALK_CONDITION: Record<Walk, string> = {
  curated: 'f.curated=1', saved: 'f.curated=0', merged: 'f.written_from>=2',
};
const WALK_INDEX: Record<Walk, string> = {
  curated: 'idx_spore_origin_facts_page', saved: 'idx_spore_origin_facts_page', merged: 'idx_spore_origin_facts_merged',
};

type PageSlots = [project: string, minSources: number, status: string | null, type: string | null, at: number | null, afterId: string | null, limit: number];
/** A first page, or the page after a cursor, which seeks past the cursor's instant rather than walking the pages before it. */
const pageOf = (walk: Walk, after: boolean) => read<PageSlots, Record<string, unknown>>({
  name: `sporeOrigins.page${walk[0]!.toUpperCase()}${walk.slice(1)}${after ? 'After' : ''}`,
  sql: `SELECT spores.project_id AS projectId, ${SPORE_READ_COLUMNS}, ${LISTED_SUCCESSORS}
    FROM (SELECT f.project_id AS fact_project,f.id AS fact_id FROM spore_origin_facts f INDEXED BY ${WALK_INDEX[walk]}
      WHERE f.project_id=?1 AND ${WALK_CONDITION[walk]} AND f.written_from>=?2 AND (?3 IS NULL OR f.status=?3) AND (?4 IS NULL OR f.observation_type=?4)
        AND ${after ? 'f.written_at<=?5 AND (f.written_at<?5 OR (f.written_at=?5 AND f.id<?6))' : '?5 IS NULL AND ?6 IS NULL'}
      ORDER BY f.written_at DESC,f.id DESC LIMIT ?7) page
    CROSS JOIN spores ON spores.project_id=page.fact_project AND spores.id=page.fact_id
    ORDER BY spores.created_at DESC,spores.id DESC`,
});
const WALKS = ['curated', 'saved', 'merged'] as const;
const PAGES = Object.fromEntries(WALKS.flatMap(walk => [[walk, pageOf(walk, false)], [`${walk}After`, pageOf(walk, true)]])) as Record<string, ReturnType<typeof pageOf>>;

const ready = read<[], { done: number }>({ name: 'sporeOrigins.ready',
  sql: `SELECT done FROM projection_catchup WHERE projection='${SPORE_ORIGIN_PROJECTION}' AND phase='${SPORE_ORIGIN_PHASE}'` });
const total = read<[project: string, curated: number, minSources: number, status: string | null, type: string | null], { n: number }>({ name: 'sporeOrigins.total',
  sql: `SELECT COALESCE(SUM(n),0) AS n FROM spore_origin_counts WHERE project_id=?1 AND curated=?2 AND written_from>=?3
    AND (?4 IS NULL OR status=?4) AND (?5 IS NULL OR observation_type=?5)` });

/**
 * One page of a Project's spores narrowed by origin, newest first with the id breaking a tie, at most `limit` + 1 rows,
 * and how many the filter admits; `building` while existing spores' origins are still being derived, when no page is
 * read. A page reads its rows and the facts of the chosen origin its status, type or source count passes over.
 */
export async function readOriginPage(db: RelationalStore, request: {
  projectId: string; filter: OriginFilter; after: { createdAt: number; id: string } | null; limit: number;
}): Promise<{ state: 'building' } | { state: 'ready'; rows: Record<string, unknown>[]; total: number }> {
  const { projectId, filter: f, after, limit } = request;
  const curated = f.origin === 'saved' ? 0 : 1;
  const minSources = f.minSources ?? 0;
  const [done, rows, counted] = await readSet(db, ready.bind(),
    PAGES[`${walkOf(f)}${after === null ? '' : 'After'}`]!.bind(projectId, minSources, f.status ?? null, f.observationType ?? null, after?.createdAt ?? null, after?.id ?? null, limit + 1),
    total.bind(projectId, curated, minSources, f.status ?? null, f.observationType ?? null));
  if (done[0]?.done !== 1) return { state: 'building' };
  return { state: 'ready', rows, total: Number(counted[0]?.n ?? 0) };
}
