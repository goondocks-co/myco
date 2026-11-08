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
import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import type { DispatchLimits } from './limits.js';
import { limitPassesSql, type ClaimedInput } from './runs.js';
import { readSpendRows, spendRowsSql } from './run-budget.js';
import { BUDGET_WINDOW_MS, seedForStage } from './budget-policy.js';
import { ESTIMATE_AGENT } from './budget-estimates.js';
import { queueHeadSeek } from './queue-heads.js';
import { capabilityOnSql, effectiveBudgetSql, projectAcceptsWorkSql } from './settings.js';
import { admissionForTask } from './task-catalogue.js';
import { CURATION_STAGE } from './spore-curation.js';
import { LEARNING_STAGES } from './learning-stages.js';

export interface SqlTerm { sql: string; params: unknown[] }

/** One due item: its Project, the single-flight subject its run carries, and what its stage reasserts at the write. */
export interface PulledItem { projectId: string; subject: string; key: string; observed: string | number | null }

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
  /** The Project's head at this stage. */
  head(db: RelationalStore, projectId: string, now: number): Promise<PulledItem | null>;
  /** The run's input for the item, or null when it offers nothing to do. */
  build(env: ServerEnv, item: PulledItem, now: number): Promise<ClaimedInput | null>;
  /** What the claim's batch adds for the item; each statement holds its own condition on the run row the batch wrote. */
  claimed?(db: RelationalStore, item: PulledItem, input: ClaimedInput, run: { runId: string; dispatchedBy: string }, now: number): Bound[];
}

/** The production stages in strict claim priority. */
export const PULLED_STAGES: readonly PulledStage[] = [...LEARNING_STAGES, CURATION_STAGE];

let installed: readonly PulledStage[] = PULLED_STAGES;

/** The stages claims pull from: the production registry unless a test harness installed others. */
export const pulledStages = (): readonly PulledStage[] => installed;

/** Install test-only stages for this process until the returned restore runs. No production path calls it. */
export function installPulledStages(stages: readonly PulledStage[]): () => void {
  const previous = installed;
  installed = stages;
  return () => { installed = previous; };
}

/** The stages whose switches are on, in one read regardless of the number of registered stages. */
export async function switchedOnStages(db: RelationalStore, stages: readonly PulledStage[]): Promise<PulledStage[]> {
  if (stages.length === 0) return [];
  const switches = [...new Set(stages.map(stage => stage.switchedOn))];
  const on = await db.prepare(`SELECT ${switches.map((sql, i) => `(${sql}) AS enabled${i}`).join(',')}`).first<Record<string, number>>();
  if (on === null) throw new Error('Pulled stage switches are unavailable');
  return stages.filter(stage => on[`enabled${switches.indexOf(stage.switchedOn)}`] === 1);
}

/** Reselections a claim makes after a pulled write refuses, before it answers no work. */
export const PULL_RESELECTIONS = 3;

/** A Project accepts a stage's work: live, with the task's capability on. */
function acceptsSql(project: string, task: string): string {
  const gate = admissionForTask(task);
  return gate?.kind === 'capability' ? capabilityOnSql(project, `'${gate.capability}'`) : projectAcceptsWorkSql(project);
}

/** Named stage assertions share the claim transaction and its observed compatibility set. */
export function pulledAssertions(stage:PulledStage,item:PulledItem,compatible:readonly PulledStage[],limits:DispatchLimits,now:number):Bound[] {
  return [stage.policy.head(item,limits,now,stage.estimateKey),
    ...compatible.filter(other=>other.level<stage.level).map(other=>other.policy.higher(item,limits,now,other.estimateKey)),
    ...compatible.filter(other=>other.level===stage.level).map(other=>other.policy.fair(item,limits,now,other.estimateKey))];
}

/** A queue the worker can execute: its task and the estimate key its execution prices an automatic row by. */
export interface ServedQueue { task: string; estimateKey: string }

/**
 * Whether queued work the worker can execute is admissible now, as the claim's queue selection admits it: each task's
 * manual and automatic heads, found by the same indexed seek, with the task passing its limits, the head's Project
 * accepting the work, outside the learning fence, and an automatic head fitting the budget at its Project's estimate.
 * A pulled write refuses while this holds. It reads at most two queue rows per task, whatever the backlog.
 */
export function queuedAdmissibleSql(queues: readonly ServedQueue[], limits: DispatchLimits, now: number): string {
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const spent = `(SELECT COALESCE(SUM(value),0) FROM (${spendRowsSql(String(Math.floor(now - BUDGET_WINDOW_MS)))}))`;
  const heads = queues.flatMap(({ task, estimateKey }) => (['manual', 'automatic'] as const).map((origin) => {
    const fits = origin === 'manual' ? '' : ` AND ${spent} + COALESCE((SELECT json_extract(s.value, '$.estimate') FROM agent_state s
          WHERE s.project_id = q.project_id AND s.agent_id = ${literal(ESTIMATE_AGENT)} AND s.key = ${literal(estimateKey)}), ${seedForStage(task)}) <= ${effectiveBudgetSql()}`;
    return `EXISTS (SELECT 1 FROM (${queueHeadSeek('project_id, task', literal(task), literal(origin))}) q
      WHERE ${limitPassesSql(task, limits, now)} AND ${acceptsSql('q.project_id', task)}${fits})`;
  }));
  return heads.length === 0 ? '0' : `(${heads.join(' OR ')})`;
}

/** Whether the queued work `queuedAdmissibleSql` describes is admissible now. */
export async function queuedAdmissible(db: RelationalStore, admissible: string): Promise<boolean> {
  return (await db.prepare(`SELECT ${admissible} AS admissible`).first<{ admissible: number }>())?.admissible === 1;
}

export interface PulledSelection { stage: PulledStage; item: PulledItem; assertions: Bound[] }

/**
 * The best due item for a worker: the lowest level with an item in E(worker) (`eligible`: compatible stages whose task
 * passes its limits now), then the Project with the least automatic spend in the trailing window, ties by Project id,
 * then that Project's head. `compatible` is every stage the worker can execute, which the write's reassertion reads.
 */
export async function selectPulled(db: RelationalStore, eligible: readonly PulledStage[], compatible: readonly PulledStage[], limits: DispatchLimits, now: number): Promise<PulledSelection | null> {
  for (const level of [...new Set(eligible.map((stage) => stage.level))].sort((a, b) => a - b)) {
    const byProject = new Map<string, PulledStage[]>();
    for (const stage of eligible.filter((candidate) => candidate.level === level)) {
      const due = stage.due('p.project_id', now);
      const { results } = await db.prepare(`SELECT p.project_id AS projectId FROM projects p WHERE ${acceptsSql('p.project_id', stage.task)} AND ${due.sql}`)
        .bind(...due.params).all<{ projectId: string }>();
      for (const { projectId } of results) byProject.set(projectId, [...(byProject.get(projectId) ?? []), stage]);
    }
    if (byProject.size === 0) continue;
    const projects = [...byProject.keys()];
    if (projects.length > 1) {
      const spent = new Map<string, number>();
      for (const row of await readSpendRows(db, now)) if (row.origin === 'automatic') spent.set(row.projectId, (spent.get(row.projectId) ?? 0) + row.value);
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
