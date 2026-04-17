/**
 * Tests for the pure helpers backing the shared `ComparisonView` component.
 * Mirrors `evaluation-helpers.test.ts` in style — the React component has
 * no RTL harness, so the non-trivial logic lives in the helpers module and
 * is covered here.
 *
 * Covered:
 *   - `aggregateRunSet` — aggregate counters over an arbitrary run set
 *   - `detectDrift`    — drift banner heuristic (span + task-diff)
 *   - `selectVisibleColumns` — diff-column visibility with mixed run sets
 *     (sanity check that the helper works on an ad-hoc run set, not just
 *     evaluation-sourced runs)
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateRunSet,
  detectDrift,
  detectSharedInputs,
  formatDriftDuration,
  selectVisibleColumns,
  DRIFT_THRESHOLD_MINUTES,
  type ColumnKey,
} from '../../packages/myco/ui/src/components/agent/evaluation-helpers';
import type { EvaluationRunSummary } from '../../packages/myco/ui/src/hooks/use-agent';

function fakeRun(over: Partial<EvaluationRunSummary>): EvaluationRunSummary {
  return {
    id: 'run-x',
    agent_id: 'myco-agent',
    task: 'full-intelligence',
    instruction: null,
    status: 'completed',
    runtime: null,
    provider: null,
    model: null,
    session_ref: null,
    started_at: null,
    completed_at: null,
    tokens_used: null,
    cost_usd: null,
    usage_data: null,
    error: null,
    dry_run: false,
    evaluation_id: null,
    reasoning_level: null,
    execution_overrides: null,
    write_intents: { total: 0, by_tool: {} },
    duration_ms: null,
    ...over,
  };
}

describe('aggregateRunSet', () => {
  it('returns zeros for an empty run set', () => {
    expect(aggregateRunSet([])).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    });
  });

  it('counts statuses and sums tokens + cost across mixed runs', () => {
    const runs: EvaluationRunSummary[] = [
      fakeRun({ id: 'a', status: 'completed', tokens_used: 100, cost_usd: 0.02 }),
      fakeRun({ id: 'b', status: 'completed', tokens_used: 250, cost_usd: 0.05 }),
      fakeRun({ id: 'c', status: 'failed', tokens_used: 50 }),
      fakeRun({ id: 'd', status: 'skipped' }),
    ];
    expect(aggregateRunSet(runs)).toEqual({
      total: 4,
      completed: 2,
      failed: 1,
      skipped: 1,
      totalTokens: 400,
      totalCostUsd: 0.07,
    });
  });

  it('ignores non-finite tokens and cost', () => {
    const runs: EvaluationRunSummary[] = [
      fakeRun({ id: 'a', tokens_used: Number.NaN, cost_usd: Number.POSITIVE_INFINITY }),
      fakeRun({ id: 'b', tokens_used: 100, cost_usd: 0.1 }),
    ];
    const agg = aggregateRunSet(runs);
    expect(agg.totalTokens).toBe(100);
    expect(agg.totalCostUsd).toBe(0.1);
  });

  it('treats unknown statuses as uncounted (not-completed / failed / skipped)', () => {
    const runs: EvaluationRunSummary[] = [
      fakeRun({ id: 'a', status: 'running' }),
      fakeRun({ id: 'b', status: 'pending' }),
    ];
    expect(aggregateRunSet(runs)).toEqual({
      total: 2,
      completed: 0,
      failed: 0,
      skipped: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    });
  });
});

describe('detectDrift', () => {
  it('does not fire for <2 runs', () => {
    expect(detectDrift([])).toEqual({ show: false, spanMinutes: 0, differentTasks: false });
    expect(detectDrift([fakeRun({ id: 'a' })])).toEqual({
      show: false,
      spanMinutes: 0,
      differentTasks: false,
    });
  });

  it('does not fire when runs span less than the threshold and share a task', () => {
    const base = 1_700_000_000;
    const drift = detectDrift([
      fakeRun({ id: 'a', task: 'full-intelligence', started_at: base }),
      fakeRun({ id: 'b', task: 'full-intelligence', started_at: base + 60 }),
    ]);
    expect(drift.show).toBe(false);
    expect(drift.differentTasks).toBe(false);
    expect(drift.spanMinutes).toBe(1);
  });

  it('fires when the span exceeds the threshold', () => {
    const base = 1_700_000_000;
    const drift = detectDrift([
      fakeRun({ id: 'a', task: 'full-intelligence', started_at: base }),
      fakeRun({ id: 'b', task: 'full-intelligence', started_at: base + (DRIFT_THRESHOLD_MINUTES + 1) * 60 }),
    ]);
    expect(drift.show).toBe(true);
    expect(drift.differentTasks).toBe(false);
    expect(drift.spanMinutes).toBeGreaterThan(DRIFT_THRESHOLD_MINUTES);
  });

  it('fires when tasks differ, even with small spans', () => {
    const base = 1_700_000_000;
    const drift = detectDrift([
      fakeRun({ id: 'a', task: 'full-intelligence', started_at: base }),
      fakeRun({ id: 'b', task: 'skill-survey', started_at: base + 30 }),
    ]);
    expect(drift.show).toBe(true);
    expect(drift.differentTasks).toBe(true);
  });

  it('ignores null started_at values when computing the span', () => {
    const base = 1_700_000_000;
    const drift = detectDrift([
      fakeRun({ id: 'a', task: 'x', started_at: null }),
      fakeRun({ id: 'b', task: 'x', started_at: base }),
    ]);
    expect(drift.spanMinutes).toBe(0);
    expect(drift.show).toBe(false);
  });
});

describe('detectSharedInputs', () => {
  it('returns sameInput:null when no instruction contains recognized keys', () => {
    const runs = [
      fakeRun({ id: 'a', instruction: 'Please regenerate the digest for this week.' }),
      fakeRun({ id: 'b', instruction: null }),
    ];
    const result = detectSharedInputs(runs);
    expect(result.sameInput).toBe(null);
  });

  it('returns sameInput:true when every run carries the same session_id', () => {
    const runs = [
      fakeRun({ id: 'a', instruction: 'Target session: session_id: abc-123\nSummarize it.' }),
      fakeRun({ id: 'b', instruction: 'Summarize session_id=abc-123 for the title feed.' }),
    ];
    const result = detectSharedInputs(runs);
    expect(result.sameInput).toBe(true);
    if (result.sameInput === true) {
      expect(result.inputs.session_id).toBe('abc-123');
    }
  });

  it('returns sameInput:false when inputs differ or are partial', () => {
    const runs = [
      fakeRun({ id: 'a', instruction: 'session_id: abc-123 batch_id: b1' }),
      fakeRun({ id: 'b', instruction: 'session_id: xyz-789' }),
      fakeRun({ id: 'c', instruction: 'no identifiers here' }),
    ];
    const result = detectSharedInputs(runs);
    expect(result.sameInput).toBe(false);
    if (result.sameInput === false) {
      expect(result.perRun).toHaveLength(3);
      expect(result.perRun[0].inputs.session_id).toBe('abc-123');
      expect(result.perRun[0].inputs.batch_id).toBe('b1');
      expect(result.perRun[1].inputs.session_id).toBe('xyz-789');
      expect(result.perRun[2].inputs).toEqual({});
    }
  });
});

describe('formatDriftDuration', () => {
  it('formats under an hour as minutes', () => {
    expect(formatDriftDuration(0)).toBe('0 minutes');
    expect(formatDriftDuration(1)).toBe('1 minute');
    expect(formatDriftDuration(12)).toBe('12 minutes');
    expect(formatDriftDuration(59)).toBe('59 minutes');
  });

  it('formats hours and days above the rollover thresholds', () => {
    expect(formatDriftDuration(60)).toBe('1 hour');
    expect(formatDriftDuration(120)).toBe('2 hours');
    expect(formatDriftDuration(24 * 60)).toBe('1 day');
    expect(formatDriftDuration(3 * 24 * 60)).toBe('3 days');
  });
});

describe('selectVisibleColumns on ad-hoc run sets', () => {
  const CANDIDATES: readonly ColumnKey[] = [
    'runtime',
    'reasoning',
    'model',
    'status',
    'tokens',
  ];

  it('returns every candidate for <2 runs (toggle is expected to be hidden)', () => {
    const runs = [fakeRun({ id: 'a' })];
    expect([...selectVisibleColumns(runs, CANDIDATES)].sort()).toEqual([...CANDIDATES].sort());
  });

  it('hides columns that are uniform across every run', () => {
    const runs = [
      fakeRun({ id: 'a', runtime: 'claude-sdk', model: 'sonnet-4-5', tokens_used: 100 }),
      fakeRun({ id: 'b', runtime: 'claude-sdk', model: 'haiku-4-5', tokens_used: 200 }),
    ];
    const visible = selectVisibleColumns(runs, CANDIDATES);
    expect(visible.has('runtime')).toBe(false); // uniform
    expect(visible.has('model')).toBe(true); // varied
    expect(visible.has('tokens')).toBe(true); // varied
    expect(visible.has('status')).toBe(true); // always visible
  });
});
