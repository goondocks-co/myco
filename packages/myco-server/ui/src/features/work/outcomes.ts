/**
 * Myco's work grouped by what came of it: `/api/work`'s outcomes and runs,
 * summed by kind of work across the projects the page covers.
 */
import type { OutcomeKind, Range, WorkAnswer, WorkOutcome, WorkRun } from '../today/wire';
import { KIND_ORDER, type OutcomeCounts } from './words';

/** One kind of work over the window, across the projects the answer covers. */
export interface KindSummary extends OutcomeCounts {
  kind: OutcomeKind;
  /** The projects this kind of work ran in, newest work first. */
  projects: string[];
  /** Runs by status, every run in the window counted once. */
  runs: Record<string, number>;
  /** Runs that started: finished or still going. */
  started: number;
  /** Failed runs that kept what they produced; their output is counted above. */
  failedWithOutput: number;
  latestAt: number | null;
  tokens: number;
  costUsd: number;
  runsWithoutCost: number;
  /** What one completed run spent, least to greatest across the projects. */
  spend: { tokens: Range; costUsd: Range; durationMs: Range };
  /** Each project's current map, for the map kind. */
  currentMaps: Array<NonNullable<WorkOutcome['map']> & { projectId: string }>;
  /** The listed runs of this kind, newest first. */
  listed: WorkRun[];
  /** Listed runs that failed and kept nothing, newest first. */
  failures: WorkRun[];
  /** Full-window failure state by Project with the listed runs available for detail. */
  failureGroups: FailureGroup[];
  /** Listed runs that failed but kept what they produced, newest first. */
  kept: WorkRun[];
}

/**
 * One project's failures of one kind of work. A failure is answered only by a
 * later run of the same kind in the same project that produced something: a
 * map that worked in another project leaves this one's failure open.
 */
export interface FailureGroup {
  projectId: string;
  /** Full-window failed runs, including those beyond the evidence page. */
  count: number;
  latestRunId: string;
  latestAt: number;
  /** Newest first. */
  failures: WorkRun[];
  /** Runs in this project that produced something after its latest failure. */
  producedSince: number;
}

/** Whether every project's failures of a kind have been answered by later output there. */
export function recovered(groups: readonly FailureGroup[]): boolean {
  return groups.length > 0 && groups.every((group) => group.producedSince > 0);
}

const merge = (a: Range, b: Range): Range => (a === null ? b : b === null ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])]);

const sum = (record: Record<string, number>, keys: readonly string[]) => keys.reduce((total, key) => total + (record[key] ?? 0), 0);

/** Every kind of work the window holds, in the page's order: learning, titles, the code map, then learning from the code. */
export function summarize(answer: WorkAnswer): KindSummary[] {
  const byKind = new Map<OutcomeKind, KindSummary>();
  const failureFacts = new Map<OutcomeKind, FailureGroup[]>();
  for (const outcome of answer.outcomes) {
    let entry = byKind.get(outcome.kind);
    if (entry === undefined) {
      entry = {
        kind: outcome.kind, projects: [], runs: {}, started: 0, spores: 0, sessions: 0, maps: 0, produced: 0, failed: 0, finished: 0,
        failedWithOutput: 0, latestAt: null, tokens: 0, costUsd: 0, runsWithoutCost: 0,
        spend: { tokens: null, costUsd: null, durationMs: null }, currentMaps: [], listed: [], failures: [], failureGroups: [], kept: [],
      };
      byKind.set(outcome.kind, entry);
    }
    entry.projects.push(outcome.projectId);
    for (const [status, n] of Object.entries(outcome.runs)) entry.runs[status] = (entry.runs[status] ?? 0) + n;
    entry.spores += outcome.outcome.spores;
    entry.sessions += outcome.outcome.sessions;
    entry.maps += outcome.outcome.maps;
    entry.failed += outcome.failed;
    entry.failedWithOutput += outcome.failedWithOutput;
    if (outcome.failure != null) {
      const groups = failureFacts.get(outcome.kind) ?? [];
      groups.push({
        projectId: outcome.projectId,
        count: outcome.failure.runs,
        latestRunId: outcome.failure.latestRunId,
        latestAt: outcome.failure.latestAt,
        producedSince: outcome.failure.producedSince,
        failures: [],
      });
      failureFacts.set(outcome.kind, groups);
    }
    if (outcome.latestAt !== null && (entry.latestAt === null || outcome.latestAt > entry.latestAt)) entry.latestAt = outcome.latestAt;
    entry.tokens += outcome.tokens;
    entry.costUsd += outcome.costUsd;
    entry.runsWithoutCost += outcome.runsWithoutCost;
    entry.spend = {
      tokens: merge(entry.spend.tokens, outcome.spend.tokens),
      costUsd: merge(entry.spend.costUsd, outcome.spend.costUsd),
      durationMs: merge(entry.spend.durationMs, outcome.spend.durationMs),
    };
    if (outcome.map !== null) entry.currentMaps.push({ ...outcome.map, projectId: outcome.projectId });
  }
  for (const entry of byKind.values()) {
    entry.finished = sum(entry.runs, ['completed', 'failed']);
    entry.started = sum(entry.runs, ['completed', 'failed', 'running', 'claimed']);
    entry.produced = entry.finished - entry.failed;
    entry.listed = answer.runs.filter((run) => run.kind === entry.kind);
    entry.failures = entry.listed.filter((run) => run.result === 'failed');
    entry.kept = entry.listed.filter((run) => run.result === 'failed_with_output');
    entry.failureGroups = (failureFacts.get(entry.kind) ?? []).map((group) => ({
      ...group,
      failures: entry.failures.filter((run) => run.projectId === group.projectId),
    })).sort((a, b) => b.latestAt - a.latestAt);
  }
  return KIND_ORDER.flatMap((kind) => byKind.get(kind) ?? []);
}

/** What the window cost, across every kind of work. */
export interface CostSummary {
  costUsd: number;
  tokens: number;
  /** Runs that started and finished. */
  runs: number;
  runsWithoutCost: number;
}

export function costOf(kinds: readonly KindSummary[]): CostSummary {
  return kinds.reduce<CostSummary>((total, kind) => ({
    costUsd: total.costUsd + kind.costUsd,
    tokens: total.tokens + kind.tokens,
    runs: total.runs + kind.finished,
    runsWithoutCost: total.runsWithoutCost + kind.runsWithoutCost,
  }), { costUsd: 0, tokens: 0, runs: 0, runsWithoutCost: 0 });
}
