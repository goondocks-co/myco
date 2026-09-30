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
  /** Listed runs that failed but kept what they produced, newest first. */
  kept: WorkRun[];
  /** Listed runs that produced something after the latest failure. */
  producedSince: number;
}

const merge = (a: Range, b: Range): Range => (a === null ? b : b === null ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])]);

const sum = (record: Record<string, number>, keys: readonly string[]) => keys.reduce((total, key) => total + (record[key] ?? 0), 0);

/** Every kind of work the window holds, in the page's order: learning, titles, the code map, then learning from the code. */
export function summarize(answer: WorkAnswer): KindSummary[] {
  const byKind = new Map<OutcomeKind, KindSummary>();
  for (const outcome of answer.outcomes) {
    let entry = byKind.get(outcome.kind);
    if (entry === undefined) {
      entry = {
        kind: outcome.kind, projects: [], runs: {}, started: 0, spores: 0, sessions: 0, maps: 0, produced: 0, failed: 0, finished: 0,
        failedWithOutput: 0, latestAt: null, tokens: 0, costUsd: 0, runsWithoutCost: 0,
        spend: { tokens: null, costUsd: null, durationMs: null }, currentMaps: [], listed: [], failures: [], kept: [], producedSince: 0,
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
    const lastFailure = entry.failures[0]?.at ?? null;
    entry.producedSince = lastFailure === null ? 0 : entry.listed.filter((run) => run.result === 'produced' && run.at !== null && run.at > lastFailure).length;
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
