import type { PullPolicy } from '../db/runs/pull-policy.js';
import type { Bound } from '../db/index.js';
/**
 * Pull at claim: the registry of pulled stages, their strict levels, the eligible set E(worker), least-spend
 * fairness across Projects and the selection each pulled write reasserts.
 *
 * A pulled stage offers due work derived from data. Nothing is queued ahead of capacity: a claim with no admissible
 * queued head selects the best due item for its worker and creates the run row through the claim capability's pulled
 * form, whose write reasserts the selection (`core/worker-claim.ts`).
 */
import type { RelationalStore, ServerEnv } from './adapters.js';
import type { DispatchLimits } from './limits.js';
import type { ClaimedInput } from './runs.js';
import { readProjectSpend } from '../db/runs/admission.js';
import { taskAcceptedSql } from '../db/runs/task-acceptance.js';
import { CURATION_STAGE } from './spore-curation.js';
import { LEARNING_STAGES } from './learning-stages.js';
import { advanceLearningDeadlines } from '../db/learning/ready.js';
import { dueProjects, stageSwitches } from '../db/runs/pulled-stage-reads.js';

interface SqlTerm { sql: string; params: unknown[] }

/** One due item: its Project, the single-flight subject its run carries, and what its stage reasserts at the write. */
export interface PulledItem { projectId: string; subject: string; key: string; observed: string | number | null }

/** The bounded Project page already selected for the current work read, and its two distinct instants. */
export interface PulledWaitScope { projects: readonly string[]; now: number; cutoff: number }
export interface PulledWait { projectId: string; since: number }

export interface PulledStage {
  /** Strict priority: a lower level is pulled before any higher one within E(worker). */
  readonly level: number;
  readonly task: string;
  readonly policy: PullPolicy;
  readonly estimateKey?: string;
  withEstimate?(key: string): PulledStage;
  /** A SQL boolean for the stage's switch; a claim reads all distinct switches together before any probe. */
  readonly switchedOn: string;
  /** Whether an item of this stage is due in the Project the SQL expression `project` names. */
  due(project: string, now: number): SqlTerm;
  /** The FROM clause, binding the Project as `p`, that candidate Projects come from; every Project when omitted. */
  readonly candidates?: string;
  /** The Project's head at this stage. */
  head(db: RelationalStore, projectId: string, now: number): Promise<PulledItem | null>;
  /** Due work's oldest deadline per requested Project, with readiness and admission evaluated now. */
  waiting?(db: RelationalStore, scope: PulledWaitScope): Promise<PulledWait[]>;
  /** The run's input for the item, or null when it offers nothing to do. */
  build(env: ServerEnv, item: PulledItem, now: number): Promise<ClaimedInput | null>;
  /** What the claim's batch adds for the item; each statement holds its own condition on the run row the batch wrote. */
  claimed?(db: RelationalStore, item: PulledItem, input: ClaimedInput, run: { runId: string; dispatchedBy: string }, now: number): Bound[];
}

/** The production stages in strict claim priority. */
export const PULLED_STAGES: readonly PulledStage[] = [...LEARNING_STAGES, CURATION_STAGE];

/** The stages claims pull from: the production registry. */
export const pulledStages = (): readonly PulledStage[] => PULLED_STAGES;

/** The stages whose switches are on, in one read regardless of the number of registered stages. */
export async function switchedOnStages(db: RelationalStore, stages: readonly PulledStage[]): Promise<PulledStage[]> {
  if (stages.length === 0) return [];
  const switches = [...new Set(stages.map(stage => stage.switchedOn))];
  const on = await stageSwitches(db, switches);
  if (on === null) throw new Error('Pulled stage switches are unavailable');
  return stages.filter(stage => on[`enabled${switches.indexOf(stage.switchedOn)}`] === 1);
}

/** Reselections a claim makes after a pulled write refuses, before it answers no work. */
export const PULL_RESELECTIONS = 3;


/** Named stage assertions share the claim transaction and its observed compatibility set. */
function pulledAssertions(stage:PulledStage,item:PulledItem,compatible:readonly PulledStage[],limits:DispatchLimits,now:number):Bound[] {
  return [stage.policy.head(item,limits,now,stage.estimateKey),
    ...compatible.filter(other=>other.level<stage.level).map(other=>other.policy.higher(item,limits,now,other.estimateKey)),
    ...compatible.filter(other=>other.level===stage.level).map(other=>other.policy.fair(item,limits,now,other.estimateKey))];
}

/** A queue the worker can execute: its task and the estimate key its execution prices an automatic row by. */
export interface ServedQueue { task: string; estimateKey: string }

interface PulledSelection { stage: PulledStage; item: PulledItem; assertions: Bound[] }

/**
 * The best due item for a worker: the lowest level with an item in E(worker) (`eligible`: compatible stages whose task
 * passes its limits now), then the Project with the least automatic spend in the trailing window, ties by Project id,
 * then that Project's head. `compatible` is every stage the worker can execute, which the write's reassertion reads.
 */
export async function selectPulled(db: RelationalStore, eligible: readonly PulledStage[], compatible: readonly PulledStage[], limits: DispatchLimits, now: number): Promise<PulledSelection | null> {
  await advanceLearningDeadlines(db, now);
  for (const level of [...new Set(eligible.map((stage) => stage.level))].sort((a, b) => a - b)) {
    const byProject = new Map<string, PulledStage[]>();
    for (const stage of eligible.filter((candidate) => candidate.level === level)) {
      const due = stage.due('p.project_id', now);
      for (const projectId of await dueProjects(db, stage.candidates ?? 'projects p', taskAcceptedSql('p.project_id', stage.task), due)) byProject.set(projectId, [...(byProject.get(projectId) ?? []), stage]);
    }
    if (byProject.size === 0) continue;
    const projects = [...byProject.keys()];
    if (projects.length > 1) {
      const spent = await readProjectSpend(db, now);
      const rounded = (projectId: string) => Math.round((spent.get(projectId) ?? 0) * 1e6) / 1e6;
      projects.sort((a, b) => rounded(a) - rounded(b) || (a < b ? -1 : a > b ? 1 : 0));
    }
    const [projectId] = projects;
    for (const stage of byProject.get(projectId!)!) {
      const item = await stage.head(db, projectId!, now);
      if (item !== null) return { stage, item, assertions: pulledAssertions(stage, item, compatible, limits, now) };
    }
    return null;
  }
  return null;
}
