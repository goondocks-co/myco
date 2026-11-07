import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write, type Bound } from '../index.js';
import { KPI_DOCUMENT_RECONCILE, KPI_JSON_KEYS, KPI_LINEAGE_RECONCILE, KPI_RECONCILE, reconcileKpi } from '../insights/kpi-reconcile.js';

export const PROJECTION_PAGE_SIZE = 50;
interface Phase {
  projection: string;
  phase: string;
  after_key: string;
  frontier: string | null;
  done: number;
}
interface Source {
  table: string;
  columns: readonly string[];
  where?: string;
}
export const KPI_PHASE_SOURCES = {
  sessions: { table: 'sessions', columns: ['project_id', 'session_id'] },
  documents: { table: 'session_documents', columns: ['project_id', 'session_id'], where: "state='live'" },
  receipts: { table: 'spore_injections', columns: ['project_id', 'session_id', 'id'] },
  conflicts: { table: 'prompt_identity_conflicts', columns: ['project_id', 'session_id', 'prompt_id', 'source_key', 'source_thread', 'source_record'] },
  answers: { table: 'prompt_context_answers', columns: ['project_id', 'session_id', 'id'] },
  transcripts: { table: 'transcripts', columns: ['project_id', 'transcript_id'] },
  lineages: { table: 'member_credentials INDEXED BY idx_member_credentials_lineage', columns: ['lineage_root'] },
} satisfies Record<string, Source>;
export type KpiPhase = keyof typeof KPI_PHASE_SOURCES;

const phases = read<[string], Phase>({ name: 'projection.phases', sql: 'SELECT projection,phase,after_key,frontier,done FROM projection_catchup WHERE projection=? ORDER BY phase' });
const pending = read<[], Phase>({ name: 'projection.pending', sql: 'SELECT projection,phase,after_key,frontier,done FROM projection_catchup WHERE done=0 ORDER BY projection,phase' });
const reset = write<[]>({ name: 'projection.reset', sql: "UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL" });
const advance = write<[string, number, string, string, string]>({ name: 'projection.advance', sql: 'UPDATE projection_catchup SET after_key=?,done=? WHERE projection=? AND phase=? AND after_key=? AND done=0' });

const tuple = (columns: readonly string[]) => columns.length === 1 ? columns[0]! : `(${columns.join(',')})`;
const jsonTuple = (columns: readonly string[], json: string) => tuple(columns.map((_, i) => `json_extract(${json},'$[${i}]')`));
const pages = Object.fromEntries(Object.entries(KPI_PHASE_SOURCES).map(([phase, spec]) => {
  const source: Source = spec;
  const order = source.columns.join(',');
  const key = `json_array(${order})`;
  const state = `projection='kpi' AND phase='${phase}'`;
  return [phase, {
    frontier: write<[]>({ name: `projection.${phase}Frontier`, sql: `UPDATE projection_catchup SET frontier=COALESCE((SELECT ${key} FROM ${source.table} WHERE ${source.where ?? '1'} ORDER BY ${source.columns.map(c => `${c} DESC`).join(',')} LIMIT 1),'[]') WHERE ${state} AND frontier IS NULL AND done=0` }),
    state: read<[], Phase>({ name: `projection.${phase}State`, sql: `SELECT projection,phase,after_key,frontier,done FROM projection_catchup WHERE ${state}` }),
    keys: read<[], { key: string }>({ name: `projection.${phase}Keys`, sql: `SELECT DISTINCT ${key} AS key FROM ${source.table}
      WHERE ${source.where ?? '1'} AND ${tuple(source.columns)} > ${jsonTuple(source.columns, `COALESCE(NULLIF((SELECT after_key FROM projection_catchup WHERE ${state}),'[]'),'${JSON.stringify(source.columns.map(() => ''))}')`)}
      AND ${tuple(source.columns)} <= ${jsonTuple(source.columns, `(SELECT frontier FROM projection_catchup WHERE ${state})`)}
      ORDER BY ${order} LIMIT ${PROJECTION_PAGE_SIZE}` }),
  }];
})) as Record<KpiPhase, {
  frontier: ReturnType<typeof write<[]>>;
  state: ReturnType<typeof read<[], Phase>>;
  keys: ReturnType<typeof read<[], { key: string }>>;
}>;

const sessionReconcile = reconcileKpi('s', `SELECT project_id,session_id,'' AS k FROM (${KPI_JSON_KEYS})`)
  .map((sql, i) => write<[string]>({ name: `kpi.sessionPage${i}`, sql }));
const conflictReconcile = reconcileKpi('i', `SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS session_id,
  json_array(${[2, 3, 4, 5].map(i => `json_extract(value,'$[${i}]')`).join(',')}) AS k FROM json_each(?1)`)
  .map((sql, i) => write<[string]>({ name: `kpi.conflictPage${i}`, sql }));
const transcriptKeys = `SELECT t.project_id,t.session_id,t.transcript_id AS k FROM json_each(?1) j JOIN transcripts t ON t.project_id=json_extract(j.value,'$[0]') AND t.transcript_id=json_extract(j.value,'$[1]')`;
const transcriptReconcile = [
  ...reconcileKpi('t', transcriptKeys),
  ...reconcileKpi('m', `SELECT DISTINCT t.project_id,t.session_id,t.agent AS k FROM json_each(?1) j JOIN transcripts t ON t.project_id=json_extract(j.value,'$[0]') AND t.transcript_id=json_extract(j.value,'$[1]')`),
].map((sql, i) => write<[string]>({ name: `kpi.transcriptPage${i}`, sql }));

const reconciles = {
  sessions: sessionReconcile, documents: KPI_DOCUMENT_RECONCILE, receipts: KPI_RECONCILE.d,
  conflicts: conflictReconcile, answers: KPI_RECONCILE.a, transcripts: transcriptReconcile, lineages: KPI_LINEAGE_RECONCILE,
};

/** Replaying keys reads current source values inside the caller's commit. */
export function kpiPageStatements(phase: KpiPhase, keys: string): Bound[] {
  return reconciles[phase].map(statement => statement.bind(keys));
}

/** A page's contributions and cursor share one atomic commit. */
export async function catchUpKpiPhase(db: RelationalStore, phase: KpiPhase): Promise<number> {
  const page = pages[phase];
  const [, state, selected] = await commit(db, page.frontier.bind(), page.state.bind(), page.keys.bind());
  const held = state.results[0];
  if (!held) throw new Error(`Missing kpi projection phase: ${phase}`);
  if (held.done === 1) return 0;
  const keys = selected.results.map(row => JSON.parse(row.key) as string[]);
  await commit(db, ...kpiPageStatements(phase, JSON.stringify(keys)),
    advance.bind(selected.results.at(-1)?.key ?? held.after_key, keys.length < PROJECTION_PAGE_SIZE ? 1 : 0, 'kpi', phase, held.after_key));
  return keys.length;
}

export async function projectionReadiness(db: RelationalStore, projection: 'kpi'): Promise<'ready' | 'building'> {
  const [rows] = await readSet(db, phases.bind(projection));
  return rows.length === Object.keys(KPI_PHASE_SOURCES).length && rows.every(row => row.done === 1) ? 'ready' : 'building';
}

export async function resetProjectionCatchup(db: RelationalStore): Promise<void> {
  await commit(db, reset.bind());
}

/** Each wake advances one bounded page of every unfinished phase. */
export async function catchUpProjections(db: RelationalStore): Promise<number> {
  const [rows] = await readSet(db, pending.bind());
  let count = 0;
  for (const row of rows) {
    if (row.projection !== 'kpi' || !Object.hasOwn(KPI_PHASE_SOURCES, row.phase)) throw new Error(`Unknown projection phase: ${row.projection}/${row.phase}`);
    count += await catchUpKpiPhase(db, row.phase as KpiPhase);
  }
  return count;
}

export function kpiCatchupSeed(): string[] {
  return Object.entries(KPI_PHASE_SOURCES).map(([phase, source]) => `INSERT INTO projection_catchup(projection,phase,done)
    SELECT 'kpi','${phase}',NOT EXISTS (SELECT 1 FROM ${source.table})`);
}
