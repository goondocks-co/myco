import { write } from '../index.js';
import { everyPhaseDone, type CatchupFamily, type PhaseSource } from '../projections/family.js';
import { KPI_DOCUMENT_RECONCILE, KPI_JSON_KEYS, KPI_LINEAGE_RECONCILE, KPI_RECONCILE, reconcileKpi } from './kpi-reconcile.js';

const KPI_DOCUMENT_PAGE_SIZE = 5;
const PHASE_SOURCES = {
  sessions: { table: 'sessions', columns: ['project_id', 'session_id'] },
  documents: { table: 'session_documents', columns: ['project_id', 'session_id'], where: "state='live'", pageSize: KPI_DOCUMENT_PAGE_SIZE },
  receipts: { table: 'spore_injections', columns: ['project_id', 'session_id', 'id'] },
  conflicts: { table: 'prompt_identity_conflicts', columns: ['project_id', 'session_id', 'prompt_id', 'source_key', 'source_thread', 'source_record'] },
  answers: { table: 'prompt_context_answers', columns: ['project_id', 'session_id', 'id'] },
  transcripts: { table: 'transcripts', columns: ['project_id', 'transcript_id'] },
  lineages: { table: 'member_credentials INDEXED BY idx_member_credentials_lineage', columns: ['lineage_root'] },
} satisfies Record<string, PhaseSource>;

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

export const KPI_CATCHUP = {
  projection: 'kpi',
  phases: {
    sessions: { source: PHASE_SOURCES.sessions, reconcile: sessionReconcile },
    documents: { source: PHASE_SOURCES.documents, reconcile: KPI_DOCUMENT_RECONCILE },
    receipts: { source: PHASE_SOURCES.receipts, reconcile: KPI_RECONCILE.d },
    conflicts: { source: PHASE_SOURCES.conflicts, reconcile: conflictReconcile },
    answers: { source: PHASE_SOURCES.answers, reconcile: KPI_RECONCILE.a },
    transcripts: { source: PHASE_SOURCES.transcripts, reconcile: transcriptReconcile },
    lineages: { source: PHASE_SOURCES.lineages, reconcile: KPI_LINEAGE_RECONCILE },
  },
} as const satisfies CatchupFamily;

export function kpiReadiness(phases: readonly { phase: string; done: number }[]) {
  const expected = Object.keys(KPI_CATCHUP.phases);
  const progress = {
    completed: expected.filter(phase => phases.some(row => row.phase === phase && row.done === 1)).length,
    total: expected.length,
  };
  return { state: everyPhaseDone(KPI_CATCHUP, phases) ? 'ready' : 'building', progress } as const;
}

export function kpiCatchupSeed(): string[] {
  return Object.entries(PHASE_SOURCES).map(([phase, source]) => `INSERT INTO projection_catchup(projection,phase,done)
    SELECT 'kpi','${phase}',NOT EXISTS (SELECT 1 FROM ${source.table})`);
}
