import { emit } from '../../telemetry.js';
import type { BlobStore, JobBudget, RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write, type Bound } from '../index.js';
import { KPI_CATCHUP } from '../insights/kpi-catchup.js';
import { PUBLICATION_VERSION_CATCHUP } from '../documents/rebuild.js';
import { PUBLICATION_PIN_CATCHUP } from '../documents/pin-schema.js';
import { PUBLICATION_OWNERSHIP_CATCHUP } from '../documents/metadata-catchup.js';
import { PUBLICATION_FAILURE_CATCHUP } from '../documents/failure-head.js';
import { LIFECYCLE_CATCHUP } from '../documents/lifecycle.js';
import { DEPENDENCY_CATCHUP } from '../documents/dependencies.js';
import { LOCATOR_CATCHUP } from '../documents/locators.js';
import { TITLE_WORK_CATCHUP } from '../sessions/title-work.js';
import { PUBLICATION_CATCHUP } from '../documents/contributions.js';
import { RUN_ADMISSION_CATCHUP } from '../runs/live.js';
import { BUDGET_CATCHUP } from '../runs/admission.js';
import { WORK_HISTORY_CATCHUP } from '../runs/history-schema.js';
import { RUN_EVIDENCE_CATCHUP } from '../runs/evidence-schema.js';
import { CALIBRATION_CATCHUP } from '../embeddings/calibration.js';
import { PASSED_OVER_CATCHUP } from '../embeddings/passed-over.js';
import { SOURCE_STATE_CATCHUP } from '../embeddings/state.js';
import { EMBEDDING_RESET_CATCHUP } from '../embeddings/work.js';
import { SPORE_COUNT_CATCHUP } from '../spores/counts.js';
import { SPORE_EDGE_CATCHUP } from '../spores/edges.js';
import { PLAN_COUNT_CATCHUP } from '../plans/counts.js';
import { STORAGE_USAGE_CATCHUP } from '../storage/usage.js';
import { LINEAGE_HEAD_CATCHUP } from '../identity/lineage-heads.js';
import { everyPhaseDone, type CatchupFamily, type CatchupPhase, type PagePlan } from './family.js';

export const PROJECTION_PAGE_SIZE = 50;
const PROJECTION_CATCHUP_BUDGET: Readonly<JobBudget> = { calls: 120, wallMs: 2_000 };
/** Every projection's catch-up. A new projection is one line here. */
const FAMILIES = [
  KPI_CATCHUP, PUBLICATION_VERSION_CATCHUP, PUBLICATION_PIN_CATCHUP, PUBLICATION_OWNERSHIP_CATCHUP, PUBLICATION_FAILURE_CATCHUP,
  LIFECYCLE_CATCHUP, DEPENDENCY_CATCHUP, PUBLICATION_CATCHUP, RUN_ADMISSION_CATCHUP, BUDGET_CATCHUP, WORK_HISTORY_CATCHUP, RUN_EVIDENCE_CATCHUP,
  CALIBRATION_CATCHUP, PASSED_OVER_CATCHUP, SOURCE_STATE_CATCHUP, EMBEDDING_RESET_CATCHUP, SPORE_COUNT_CATCHUP, SPORE_EDGE_CATCHUP, PLAN_COUNT_CATCHUP, STORAGE_USAGE_CATCHUP, LINEAGE_HEAD_CATCHUP, LOCATOR_CATCHUP, TITLE_WORK_CATCHUP,
] as const satisfies readonly CatchupFamily[];

type PhaseNames<Family> = Family extends { phases: infer Phases } ? keyof Phases & string : never;
type ProjectionPhase = PhaseNames<(typeof FAMILIES)[number]>;
type ProjectionName = (typeof FAMILIES)[number]['projection'];

interface Phase {
  projection: string;
  phase: string;
  after_key: string;
  frontier: string | null;
  done: number;
  generation: number;
}
const REGISTERED = new Map<string, { projection: string; phase: CatchupPhase }>();
for (const family of FAMILIES) {
  for (const [name, phase] of Object.entries<CatchupPhase>(family.phases)) {
    if (REGISTERED.has(name)) throw new Error(`Duplicate projection phase: ${name}`);
    REGISTERED.set(name, { projection: family.projection, phase });
  }
}
const registered = (phase: string) => REGISTERED.get(phase)!;

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
const pages = Object.fromEntries([...REGISTERED].map(([phase, { projection, phase: { source } }]) => {
  const order = source.columns.join(',');
  const key = `json_array(${order})`;
  const state = `projection='${projection}' AND phase='${phase}'`;
  return [phase, {
    frontier: write<[]>({ name: `projection.${phase}Frontier`, sql: `UPDATE projection_catchup SET frontier=COALESCE((SELECT ${key} FROM ${source.table} WHERE ${source.where ?? '1'} ORDER BY ${source.columns.map(c => `${c} DESC`).join(',')} LIMIT 1),'[]') WHERE ${state} AND frontier IS NULL AND done=0` }),
    state: read<[], Phase>({ name: `projection.${phase}State`, sql: `SELECT projection,phase,after_key,frontier,done,generation FROM projection_catchup WHERE ${state}` }),
    keys: read<[], { key: string }>({ name: `projection.${phase}Keys`, sql: `SELECT ${source.unique ? '' : 'DISTINCT '}${key} AS key FROM ${source.table}
      WHERE ${source.where ?? '1'} AND ${tuple(source.columns)} > ${jsonTuple(source.columns, `COALESCE(NULLIF((SELECT after_key FROM projection_catchup WHERE ${state}),'[]'),'${JSON.stringify(source.startKey ?? source.columns.map(() => ''))}')`)}
      AND ${tuple(source.columns)} <= ${jsonTuple(source.columns, `(SELECT frontier FROM projection_catchup WHERE ${state})`)}
      ORDER BY ${order} LIMIT ${source.pageSize ?? PROJECTION_PAGE_SIZE}` }),
  }];
})) as Record<string, {
  frontier: ReturnType<typeof write<[]>>;
  state: ReturnType<typeof read<[], Phase>>;
  keys: ReturnType<typeof read<[], { key: string }>>;
}>;

/** Replaying keys reads current source values inside the caller's commit. */
export function kpiPageStatements(phase: ProjectionPhase, keys: string, now = Date.now()): Bound[] {
  return registered(phase).phase.reconcile.map(statement => 'bindAt' in statement ? statement.bindAt(keys, now) : statement.bind(keys));
}

/** A page's contributions and cursor share one atomic commit. */
export async function catchUpPhase(db: RelationalStore, phase: ProjectionPhase, now = Date.now(), blobs?: BlobStore, charge: (calls: number) => void = () => {}): Promise<number> {
  const page = pages[phase]!;
  const { projection, phase: spec } = registered(phase);
  const frontierAssertions = spec.frontier?.() ?? [];
  charge(3 + frontierAssertions.length);
  const [, state, selected] = await commit(db, page.frontier.bind(), page.state.bind(), page.keys.bind(), ...frontierAssertions);
  const held = state.results[0];
  if (!held) throw new Error(`Missing projection phase: ${phase}`);
  if (held.done === 1) return 0;
  const keys = selected.results.map(row => JSON.parse(row.key) as string[]);
  const plan: PagePlan = await spec.page?.({ db, blobs, keys, charge, generation: held.generation, now }) ?? { statements: [], complete: true };
  const guards = spec.guards?.(held) ?? [];
  const statements = [...guards, ...plan.statements, ...kpiPageStatements(phase, JSON.stringify(keys), now)];
  charge(statements.length + 1);
  try {
    await commit(db, ...statements,
      advance.bind(plan.complete ? selected.results.at(-1)?.key ?? held.after_key : held.after_key, plan.complete && keys.length < (spec.source.pageSize ?? PROJECTION_PAGE_SIZE) ? 1 : 0, projection, phase, held.after_key, held.generation));
  } catch (error) {
    const recovered = plan.recover?.(error);
    if (recovered === undefined) throw error;
    charge(guards.length + recovered.length + 1);
    await commit(db, ...guards, ...recovered, advance.bind(selected.results.at(-1)?.key ?? held.after_key, 0, projection, phase, held.after_key, held.generation));
  }
  return keys.length;
}

export async function projectionReadiness(db: RelationalStore, projection: ProjectionName): Promise<'ready' | 'building'> {
  const [rows] = await readSet(db, projectionPhases.bind(projection));
  return everyPhaseDone(FAMILIES.find(family => family.projection === projection)!, rows) ? 'ready' : 'building';
}

export async function resetProjectionCatchup(db: RelationalStore): Promise<void> {
  await commit(db, reset.bind(), ...FAMILIES.flatMap(family => ('reset' in family ? family.reset() : [])));
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
    const entry = REGISTERED.get(row.phase);
    if (entry === undefined || row.projection !== entry.projection) throw new Error(`Unknown projection phase: ${row.projection}/${row.phase}`);
    const phase = row.phase as ProjectionPhase;
    // Three frontier/key statements, reconciliation, the cursor write and one fresh pending read.
    const pageCalls = 3 + (entry.phase.frontier?.().length ?? 0) + entry.phase.reconcile.length + 2;
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
