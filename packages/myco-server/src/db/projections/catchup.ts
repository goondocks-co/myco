import { VERSION_PHASE_SOURCES, VERSION_RECONCILE, rebuildForVersion, type VersionPhase } from '../documents/rebuild.js';
import { PIN_SOURCE, PIN_ADMISSION_SOURCE, PIN_RECONCILE, PIN_ADMISSION_RECONCILE, PIN_GROUPS_READY } from '../documents/pin-schema.js';
import { metadataCursorHeld, metadataFailure, metadataPage } from '../documents/metadata-catchup.js';
import { emit } from '../../telemetry.js';
import { DOCUMENT_OWNERSHIP_CONFLICT, METADATA_PHASE_SOURCE, OWNERSHIP_READY_SOURCE, OWNERSHIP_INPUTS_READY, OWNERSHIP_READY_RECONCILE } from '../documents/ownership.js';
import { FAILURE_PHASE_SOURCE, FAILURE_RECONCILE, FAILURE_RECORD_SOURCE, FAILURE_RECORD_RECONCILE } from '../documents/failure-head.js';
import { LIFECYCLE_PHASE_SOURCE, LIFECYCLE_PROJECTION, LIFECYCLE_RECONCILE } from '../documents/lifecycle.js';
import { DEPENDENCY_PHASE_SOURCE, DEPENDENCY_PROJECTION, DEPENDENCY_RECONCILE } from '../documents/dependencies.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { RUN_ADMISSION_PROJECTION, LIVE_CATCHUP } from '../runs/live.js';
import { CALIBRATION_PHASE_SOURCES, CALIBRATION_RECONCILE } from '../embeddings/calibration.js';
import { PASSED_OVER_RECONCILE } from '../embeddings/passed-over.js';
import { SOURCE_STATE_RECONCILE } from '../embeddings/state.js';
import { RESET_PHASE_SOURCES, RESET_RECONCILE } from '../embeddings/work.js';
import { PUBLICATION_DOCUMENT_RECONCILE, PUBLICATION_INPUTS_READY, PUBLICATION_SOURCE_RECONCILE } from '../documents/contributions.js';
import type { BlobStore, JobBudget, RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, refused, write, type Bound } from '../index.js';
import { BUDGET_PROJECTION, SPEND_CATCHUP } from '../runs/admission.js';
import { WORK_CATCHUP, WORK_HISTORY_PROJECTION, WORK_RUN_ELIGIBLE } from '../runs/history-schema.js';
import { BUDGET_WINDOW_MS } from '../../core/budget-policy.js';
import { SPORE_COUNT_PROJECTION, SPORE_COUNT_RECONCILE } from '../spores/counts.js';
import { PLAN_COUNT_PROJECTION, PLAN_COUNT_RECONCILE } from '../plans/counts.js';
import { STORAGE_USAGE_PHASE, STORAGE_USAGE_PROJECTION, STORAGE_USAGE_RECONCILE, STORAGE_USAGE_SOURCE, clearStorageUsage, storageUsageCursorHeld } from '../storage/usage.js';
import { KPI_DOCUMENT_RECONCILE, KPI_JSON_KEYS, KPI_LINEAGE_RECONCILE, KPI_RECONCILE, reconcileKpi } from '../insights/kpi-reconcile.js';

export const PROJECTION_PAGE_SIZE = 50;
export const KPI_DOCUMENT_PAGE_SIZE = 5;
export const PROJECTION_CATCHUP_BUDGET: Readonly<JobBudget> = { calls: 120, wallMs: 2_000 };
interface Phase {
  projection: string;
  phase: string;
  after_key: string;
  frontier: string | null;
  done: number;
  generation: number;
}
interface Source {
  table: string;
  columns: readonly string[];
  where?: string;
  pageSize?: number;
  startKey?: readonly (string|number)[];
  /** Every key is unique, so a page stops at its limit instead of sorting the whole range. */
  unique?: boolean;
}
export const KPI_PHASE_SOURCES = {
  sessions: { table: 'sessions', columns: ['project_id', 'session_id'] },
  documents: { table: 'session_documents', columns: ['project_id', 'session_id'], where: "state='live'", pageSize: KPI_DOCUMENT_PAGE_SIZE },
  receipts: { table: 'spore_injections', columns: ['project_id', 'session_id', 'id'] },
  conflicts: { table: 'prompt_identity_conflicts', columns: ['project_id', 'session_id', 'prompt_id', 'source_key', 'source_thread', 'source_record'] },
  answers: { table: 'prompt_context_answers', columns: ['project_id', 'session_id', 'id'] },
  transcripts: { table: 'transcripts', columns: ['project_id', 'transcript_id'] },
  lineages: { table: 'member_credentials INDEXED BY idx_member_credentials_lineage', columns: ['lineage_root'] },
} satisfies Record<string, Source>;
export type KpiPhase = keyof typeof KPI_PHASE_SOURCES;

export const projectionPhases = read<[string], Phase>({ name: 'projection.phases', sql: 'SELECT projection,phase,after_key,frontier,done FROM projection_catchup WHERE projection=? ORDER BY phase' });
const pending = read<[], Phase>({ name: 'projection.pending', sql: "SELECT projection,phase,after_key,frontier,done FROM projection_catchup WHERE done=0 ORDER BY CASE projection WHEN 'run_admission' THEN 0 WHEN 'publication_pins' THEN 1 ELSE 2 END,projection,phase" });
/**
 * Restart every phase. Only a phase that has progressed takes a new generation: a page sets its frontier in the same
 * commit as its state read, so a phase still at its start has no page in flight, and restarting it twice is a no-op.
 */
const reset = write<[]>({ name: 'projection.reset', sql: "UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+CASE WHEN done=0 AND after_key='[]' AND frontier IS NULL THEN 0 ELSE 1 END" });
/** A page settles only the generation it read: a phase restarted after that read is never advanced or finished by it. */
const advance = write<[string, number, string, string, string, number]>({ name: 'projection.advance',
  sql: 'UPDATE projection_catchup SET after_key=?,done=? WHERE projection=? AND phase=? AND after_key=? AND done=0 AND generation=?' });

const tuple = (columns: readonly string[]) => columns.length === 1 ? columns[0]! : `(${columns.join(',')})`;
const jsonTuple = (columns: readonly string[], json: string) => tuple(columns.map((_, i) => `json_extract(${json},'$[${i}]')`));
const PHASE_SOURCES = {
  ...KPI_PHASE_SOURCES,
  ...VERSION_PHASE_SOURCES,
  publicationPinGroups: PIN_SOURCE, publicationPinsReady: PIN_ADMISSION_SOURCE,
  publicationMetadata: METADATA_PHASE_SOURCE,
  publicationOwnershipReady: OWNERSHIP_READY_SOURCE,
  publicationFailures: FAILURE_PHASE_SOURCE,
  publicationFailureRecord: FAILURE_RECORD_SOURCE,
  sessionLifecycle: LIFECYCLE_PHASE_SOURCE,
  publicationDependencies: DEPENDENCY_PHASE_SOURCE,
  publicationInputs: { table: 'transcripts', columns: ['project_id', 'transcript_id'] },
  publicationSessions: { table: 'session_documents', columns: ['project_id', 'session_id'] },
  runs: { table: 'agent_runs INDEXED BY idx_agent_runs_admission_catchup', columns: ['project_id', 'id'], where: IN_FLIGHT_RUN_STATUSES },
  failures: { table: 'embedding_source_failures', columns: ['project_id', 'type', 'record_id', 'model_key'] },
  versions: { table: 'embedding_versions', columns: ['project_id', 'type', 'record_id'] },
  attempts: { table: 'agent_run_attempts', columns: ['project_id', 'run_id', 'attempt_id'] },
  spores: { table: 'spores', columns: ['project_id', 'id'] },
  plans: { table: 'plans', columns: ['project_id', 'plan_key'] },
  workRuns: { table: 'agent_runs', columns: ['project_id', 'id'], where: WORK_RUN_ELIGIBLE },
  ...RESET_PHASE_SOURCES,
  ...CALIBRATION_PHASE_SOURCES,
  [STORAGE_USAGE_PHASE]: STORAGE_USAGE_SOURCE,
} satisfies Record<string, Source>;
type ProjectionPhase = keyof typeof PHASE_SOURCES;
const projectionOf = (phase: ProjectionPhase) => phase === STORAGE_USAGE_PHASE ? STORAGE_USAGE_PROJECTION : phase === 'runs' ? RUN_ADMISSION_PROJECTION : phase === 'failures' ? 'passed_over' : phase === 'versions' ? 'embedding_state'
  : phase in VERSION_PHASE_SOURCES ? 'publication_version'
  : (phase === 'publicationPinGroups' || phase === 'publicationPinsReady') ? 'publication_pins'
  : (phase === 'publicationMetadata' || phase === 'publicationOwnershipReady') ? 'publication_ownership'
  : phase === 'attempts' ? BUDGET_PROJECTION : phase === 'workRuns' ? WORK_HISTORY_PROJECTION : phase === 'spores' ? SPORE_COUNT_PROJECTION : phase === 'plans' ? PLAN_COUNT_PROJECTION : (phase === 'publicationFailures' || phase === 'publicationFailureRecord') ? 'publication_failures' : phase === 'sessionLifecycle' ? LIFECYCLE_PROJECTION : phase === 'publicationDependencies' ? DEPENDENCY_PROJECTION : phase.startsWith('publication') ? 'publication'
  : phase in RESET_PHASE_SOURCES ? 'embedding_reset' : phase in CALIBRATION_PHASE_SOURCES ? 'embedding_calibration' : 'kpi';
const frontierAssertions = (phase: ProjectionPhase) => phase === 'publicationSessions' ? [PUBLICATION_INPUTS_READY.bind('[]')] : phase === 'publicationOwnershipReady' ? [OWNERSHIP_INPUTS_READY.bind()] : phase === 'publicationPinsReady' ? [PIN_GROUPS_READY.bind()] : [];
const pageSize = (phase: ProjectionPhase) => (PHASE_SOURCES[phase] as Source).pageSize ?? PROJECTION_PAGE_SIZE;
const pages = Object.fromEntries(Object.entries(PHASE_SOURCES).map(([phase, spec]) => {
  const source: Source = spec;
  const order = source.columns.join(',');
  const key = `json_array(${order})`;
  const state = `projection='${projectionOf(phase as ProjectionPhase)}' AND phase='${phase}'`;
  return [phase, {
    frontier: write<[]>({ name: `projection.${phase}Frontier`, sql: `UPDATE projection_catchup SET frontier=COALESCE((SELECT ${key} FROM ${source.table} WHERE ${source.where ?? '1'} ORDER BY ${source.columns.map(c => `${c} DESC`).join(',')} LIMIT 1),'[]') WHERE ${state} AND frontier IS NULL AND done=0` }),
    state: read<[], Phase>({ name: `projection.${phase}State`, sql: `SELECT projection,phase,after_key,frontier,done,generation FROM projection_catchup WHERE ${state}` }),
    keys: read<[], { key: string }>({ name: `projection.${phase}Keys`, sql: `SELECT ${source.unique ? '' : 'DISTINCT '}${key} AS key FROM ${source.table}
      WHERE ${source.where ?? '1'} AND ${tuple(source.columns)} > ${jsonTuple(source.columns, `COALESCE(NULLIF((SELECT after_key FROM projection_catchup WHERE ${state}),'[]'),'${JSON.stringify(source.startKey ?? source.columns.map(() => ''))}')`)}
      AND ${tuple(source.columns)} <= ${jsonTuple(source.columns, `(SELECT frontier FROM projection_catchup WHERE ${state})`)}
      ORDER BY ${order} LIMIT ${source.pageSize ?? PROJECTION_PAGE_SIZE}` }),
  }];
})) as Record<ProjectionPhase, {
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
  ...VERSION_RECONCILE,
  publicationPinGroups: PIN_RECONCILE, publicationPinsReady: PIN_ADMISSION_RECONCILE,
  publicationMetadata: [], publicationOwnershipReady: OWNERSHIP_READY_RECONCILE,
  publicationFailures: FAILURE_RECONCILE,
  publicationFailureRecord: FAILURE_RECORD_RECONCILE,
  sessionLifecycle: LIFECYCLE_RECONCILE, publicationDependencies: DEPENDENCY_RECONCILE,
  publicationInputs: PUBLICATION_SOURCE_RECONCILE, publicationSessions: PUBLICATION_DOCUMENT_RECONCILE,
  runs: LIVE_CATCHUP, workRuns: WORK_CATCHUP,
  failures: PASSED_OVER_RECONCILE, versions: SOURCE_STATE_RECONCILE, spores: SPORE_COUNT_RECONCILE, plans: PLAN_COUNT_RECONCILE, ...RESET_RECONCILE, calibrationReceipts: CALIBRATION_RECONCILE, calibrationMembers: CALIBRATION_RECONCILE, sessions: sessionReconcile, documents: KPI_DOCUMENT_RECONCILE, receipts: KPI_RECONCILE.d,
  conflicts: conflictReconcile, answers: KPI_RECONCILE.a, transcripts: transcriptReconcile, lineages: KPI_LINEAGE_RECONCILE,
  [STORAGE_USAGE_PHASE]: STORAGE_USAGE_RECONCILE,
};

/** Replaying keys reads current source values inside the caller's commit; spend facts settle against the page's own window floor. */
export function kpiPageStatements(phase: ProjectionPhase, keys: string, now = Date.now()): Bound[] {
  return phase in VERSION_PHASE_SOURCES ? rebuildForVersion(phase as VersionPhase, keys) : phase === 'attempts' ? SPEND_CATCHUP.map(statement => statement.bind(keys, now - BUDGET_WINDOW_MS))
    : reconciles[phase].map(statement => statement.bind(keys));
}

/** A page's contributions and cursor share one atomic commit. */
export async function catchUpPhase(db: RelationalStore, phase: ProjectionPhase, now = Date.now(), blobs?: BlobStore, charge: (calls: number) => void = () => {}): Promise<number> {
  const page = pages[phase];
  charge(3 + frontierAssertions(phase).length);
  const [, state, selected] = await commit(db, page.frontier.bind(), page.state.bind(), page.keys.bind(),
    ...frontierAssertions(phase));
  const held = state.results[0];
  if (!held) throw new Error(`Missing projection phase: ${phase}`);
  if (held.done === 1) return 0;
  const keys = selected.results.map(row => JSON.parse(row.key) as string[]);
  if (phase === 'publicationMetadata' && keys.length > 0 && blobs === undefined) throw new Error('publication_metadata_blob_store_required');
  const metadata = phase === 'publicationMetadata' ? await metadataPage(db, blobs!, keys, charge,held.generation,now) : {statements:[],guards:[],complete:true};
  const guards = phase === 'publicationMetadata' ? [metadataCursorHeld.bind(held.after_key,held.generation)]
    : phase === STORAGE_USAGE_PHASE ? [storageUsageCursorHeld.bind(held.after_key,held.generation)] : [];
  const statements = [...guards, ...metadata.statements, ...kpiPageStatements(phase, JSON.stringify(keys), now)];
  charge(statements.length + 1);
  try {
    await commit(db, ...statements,
      advance.bind(metadata.complete ? selected.results.at(-1)?.key ?? held.after_key : held.after_key, metadata.complete && keys.length < pageSize(phase) ? 1 : 0, projectionOf(phase), phase, held.after_key, held.generation));
  } catch(error) {
    if(phase!=='publicationMetadata'||!refused(error,DOCUMENT_OWNERSHIP_CONFLICT))throw error;
    const failure=metadataFailure(keys,held.generation,now,DOCUMENT_OWNERSHIP_CONFLICT);
    charge(guards.length+metadata.guards.length+failure.length+1);
    await commit(db,...guards,...metadata.guards,...failure,advance.bind(selected.results.at(-1)?.key??held.after_key,0,projectionOf(phase),phase,held.after_key,held.generation));
  }
  return keys.length;
}

export function kpiReadiness(phases: readonly Pick<Phase, 'phase' | 'done'>[]) {
  const expected = Object.keys(KPI_PHASE_SOURCES);
  const progress = {
    completed: expected.filter(phase => phases.some(row => row.phase === phase && row.done === 1)).length,
    total: expected.length,
  };
  const state = phases.length === progress.total && progress.completed === progress.total ? 'ready' : 'building';
  return { state, progress } as const;
}

export const publicationReady = (phases: readonly Pick<Phase, 'phase' | 'done'>[]) =>
  ['publicationInputs','publicationSessions'].every(phase => phases.some(row => row.phase === phase && row.done === 1));

const SINGLE_PHASE = { [RUN_ADMISSION_PROJECTION]: 'runs', passed_over: 'failures', embedding_state: 'versions', [BUDGET_PROJECTION]: 'attempts',
  [SPORE_COUNT_PROJECTION]: 'spores', [PLAN_COUNT_PROJECTION]: 'plans', [WORK_HISTORY_PROJECTION]: 'workRuns', [STORAGE_USAGE_PROJECTION]: STORAGE_USAGE_PHASE, [LIFECYCLE_PROJECTION]: 'sessionLifecycle', [DEPENDENCY_PROJECTION]: 'publicationDependencies' } as const;
export async function projectionReadiness(db: RelationalStore, projection: 'kpi' | 'publication' | keyof typeof SINGLE_PHASE): Promise<'ready' | 'building'> {
  const [rows] = await readSet(db, projectionPhases.bind(projection));
  if (projection === 'kpi') return kpiReadiness(rows).state;
  if (projection === 'publication') return publicationReady(rows) ? 'ready' : 'building';
  const phase = SINGLE_PHASE[projection];
  return rows.length === 1 && rows[0]!.phase === phase && rows[0]!.done === 1 ? 'ready' : 'building';
}

export async function resetProjectionCatchup(db: RelationalStore): Promise<void> {
  await commit(db, reset.bind(), clearStorageUsage.bind());
}

/** Drains atomic pages within a statement and elapsed-time allowance; unfinished phases request another wake. */
export async function catchUpProjections(
  db: RelationalStore,
  { budget = PROJECTION_CATCHUP_BUDGET, clock = Date.now, blobs }: { budget?: Readonly<JobBudget>; clock?: () => number; blobs?: BlobStore } = {},
): Promise<{ changed: number; more: boolean; failures?:readonly {projection:string;phase:string}[] }> {
  const deadline = clock() + budget.wallMs;
  let [rows] = await readSet(db, pending.bind());
  let changed = 0;
  let calls = 1;
  let longestPageMs = 0;
  const deferred = Symbol('projection_page_deferred');
  const skipped=new Set<string>();
  const failures:{projection:string;phase:string}[]=[];
  const charge = (count: number) => { if (calls + count + 1 > budget.calls) throw deferred; calls += count; };
  while (rows.length > 0) {
    const row = rows.find(row=>!skipped.has(row.projection));
    if(row===undefined)break;
    if (!Object.hasOwn(PHASE_SOURCES, row.phase) || row.projection !== projectionOf(row.phase as ProjectionPhase)) throw new Error(`Unknown projection phase: ${row.projection}/${row.phase}`);
    const phase = row.phase as ProjectionPhase;
    // Three frontier/key statements, reconciliation, the cursor write and one fresh pending read.
    const pageCalls = 3 + frontierAssertions(phase).length + (phase === 'attempts' ? SPEND_CATCHUP.length : reconciles[phase].length) + 2;
    const start = clock();
    if (calls + pageCalls > budget.calls || start + longestPageMs >= deadline) break;
    try { changed += await catchUpPhase(db, phase, start, blobs, charge); }
    catch (error) {
      if (error === deferred) break;
      skipped.add(row.projection);
      failures.push({projection:row.projection,phase:row.phase});
      emit({kind:'projection_catchup_failed',projection:row.projection,phase:row.phase});
    }
    [rows] = await readSet(db, pending.bind());
    calls += 1;
    longestPageMs = Math.max(longestPageMs, clock() - start);
  }
  return { changed, more: rows.some(row=>!skipped.has(row.projection)),...(failures.length===0?{}:{failures}) };
}

export function kpiCatchupSeed(): string[] {
  return Object.entries(KPI_PHASE_SOURCES).map(([phase, source]) => `INSERT INTO projection_catchup(projection,phase,done)
    SELECT 'kpi','${phase}',NOT EXISTS (SELECT 1 FROM ${source.table})`);
}
