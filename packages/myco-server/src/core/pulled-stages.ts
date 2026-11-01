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
import { pausedLearningSql } from './learning-pause.js';
import { queueHeadSeek } from './queue-heads.js';
import { capabilityOnSql, effectiveBudgetSql, projectAcceptsWorkSql } from './settings.js';
import { admissionForTask } from './task-catalogue.js';
import { LEARNING_STAGES } from './learning-stages.js';

export interface SqlTerm { sql: string; params: unknown[] }

/** One due item: its Project, the single-flight subject its run carries, and what its stage reasserts at the write. */
export interface PulledItem { projectId: string; subject: string; key: string; observed: string | number | null }

export interface PulledStage {
  /** Strict priority: a lower level is pulled before any higher one within E(worker). */
  readonly level: number;
  readonly task: string;
  /** Whether the stage's work is switched on; a claim reads each distinct switch once, before any probe. */
  switchedOn(db: RelationalStore): Promise<boolean>;
  /** Whether an item of this stage is due in the Project the SQL expression `project` names. */
  due(project: string, now: number): SqlTerm;
  /** The Project's head at this stage. */
  head(db: RelationalStore, projectId: string, now: number): Promise<PulledItem | null>;
  /** The item still exists and is still its Project's head. */
  stillHead(item: PulledItem, now: number): SqlTerm;
  /** The run's input for the item, or null when it offers nothing to do. */
  build(env: ServerEnv, item: PulledItem, now: number): Promise<ClaimedInput | null>;
  /** What the claim's batch adds for the item; each statement holds its own condition on the run row the batch wrote. */
  claimed?(db: RelationalStore, item: PulledItem, input: ClaimedInput, run: { runId: string; dispatchedBy: string }, now: number): PreparedStatement[];
}

/** The production registry: the two learning stages, turn cards and session learning, each fresh and history. */
export const PULLED_STAGES: readonly PulledStage[] = LEARNING_STAGES;

let installed: readonly PulledStage[] = PULLED_STAGES;

/** The stages claims pull from: the production registry unless a test harness installed others. */
export const pulledStages = (): readonly PulledStage[] => installed;

/** Install test-only stages for this process until the returned restore runs. No production path calls it. */
export function installPulledStages(stages: readonly PulledStage[]): () => void {
  const previous = installed;
  installed = stages;
  return () => { installed = previous; };
}

/** The stages whose switches are on, each distinct switch read once. */
export async function switchedOnStages(db: RelationalStore, stages: readonly PulledStage[]): Promise<PulledStage[]> {
  const on = new Map<PulledStage['switchedOn'], boolean>();
  for (const stage of stages) if (!on.has(stage.switchedOn)) on.set(stage.switchedOn, await stage.switchedOn(db));
  return stages.filter((stage) => on.get(stage.switchedOn) === true);
}

/** Reselections a claim makes after a pulled write refuses, before it answers no work. */
export const PULL_RESELECTIONS = 3;

/** A Project accepts a stage's work: live, with the task's capability on. */
function acceptsSql(project: string, task: string): string {
  const gate = admissionForTask(task);
  return gate?.kind === 'capability' ? capabilityOnSql(project, `'${gate.capability}'`) : projectAcceptsWorkSql(project);
}

/** A due item of `stage` in any Project that accepts its work. */
function dueAnywhere(stage: PulledStage, now: number): SqlTerm {
  const due = stage.due('p.project_id', now);
  return { sql: `EXISTS (SELECT 1 FROM projects p WHERE ${acceptsSql('p.project_id', stage.task)} AND ${due.sql})`, params: due.params };
}

/**
 * What the pulled write reasserts, evaluated inside it: no compatible item at a higher level whose task passes its
 * limits now; the item is still its Project's head; and no other Project with an item at this level in E has less
 * automatic spend in the trailing window, or equal spend and a smaller id. Only the compatibility set (fenced by
 * the settings guard) and the item's identity are parameters.
 */
export function pulledReassertion(stage: PulledStage, item: PulledItem, compatible: readonly PulledStage[], limits: DispatchLimits, now: number): SqlTerm {
  const higher = compatible.filter((other) => other.level < stage.level).map((other) => {
    const due = dueAnywhere(other, now);
    return { sql: `NOT (${due.sql} AND ${limitPassesSql(other.task, limits, now)})`, params: due.params };
  });
  const rivals = compatible.filter((other) => other.level === stage.level).map((other) => {
    const due = other.due('p.project_id', now);
    return { sql: `(${acceptsSql('p.project_id', other.task)} AND ${due.sql} AND ${limitPassesSql(other.task, limits, now)})`, params: due.params };
  });
  const head = stage.stillHead(item, now);
  const floor = now - BUDGET_WINDOW_MS;
  const fair = `NOT EXISTS (SELECT 1 FROM projects p
      CROSS JOIN (SELECT ROUND(COALESCE(SUM(value),0),6) AS spent FROM (${spendRowsSql('?')}) WHERE origin='automatic' AND projectId=?) mine
      LEFT JOIN (SELECT projectId, ROUND(SUM(value),6) AS spent FROM (${spendRowsSql('?')}) WHERE origin='automatic' GROUP BY projectId) other ON other.projectId = p.project_id
      WHERE p.project_id != ? AND (${rivals.map((rival) => rival.sql).join(' OR ')})
        AND (COALESCE(other.spent,0) < mine.spent OR (COALESCE(other.spent,0) = mine.spent AND p.project_id < ?)))`;
  const terms = [...higher, head, { sql: fair, params: [floor, item.projectId, floor, item.projectId, ...rivals.flatMap((rival) => rival.params), item.projectId] }];
  return { sql: terms.map((term) => `(${term.sql})`).join(' AND '), params: terms.flatMap((term) => term.params) };
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
      WHERE ${limitPassesSql(task, limits, now)} AND ${acceptsSql('q.project_id', task)} AND NOT ${pausedLearningSql('q.task')}${fits})`;
  }));
  return heads.length === 0 ? '0' : `(${heads.join(' OR ')})`;
}

/** Whether the queued work `queuedAdmissibleSql` describes is admissible now. */
export async function queuedAdmissible(db: RelationalStore, admissible: string): Promise<boolean> {
  return (await db.prepare(`SELECT ${admissible} AS admissible`).first<{ admissible: number }>())?.admissible === 1;
}

export interface PulledSelection { stage: PulledStage; item: PulledItem; reassertion: SqlTerm }

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
    const spent = new Map<string, number>();
    for (const row of await readSpendRows(db, now)) if (row.origin === 'automatic') spent.set(row.projectId, (spent.get(row.projectId) ?? 0) + row.value);
    const rounded = (projectId: string) => Math.round((spent.get(projectId) ?? 0) * 1e6) / 1e6;
    const [projectId] = [...byProject.keys()].sort((a, b) => rounded(a) - rounded(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const stage of byProject.get(projectId!)!) {
      const item = await stage.head(db, projectId!, now);
      if (item !== null) return { stage, item, reassertion: pulledReassertion(stage, item, compatible, limits, now) };
    }
    return null;
  }
  return null;
}
