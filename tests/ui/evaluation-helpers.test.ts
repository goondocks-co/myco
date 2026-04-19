/**
 * Tests for the pure helpers behind EvaluationDetail's comparison table.
 * These exist because the component itself doesn't have a test harness yet
 * (no jsdom + react-testing-library config for the agent page) — the
 * non-trivial logic was extracted into evaluation-helpers.ts specifically
 * so it can be unit-tested here.
 */

import { describe, expect, it } from 'vitest';
import {
  TASK_DEFAULT_LABEL,
  deriveRunReasoning,
  deriveCellLabel,
  computeCostPerWrite,
  computeDeltas,
  formatWriteIntentsByTool,
  sumPhaseTurns,
  selectVisibleColumns,
  buildPhaseBreakdown,
  countPhaseOverrides,
  formatPhaseOverrideTooltip,
  type ColumnKey,
} from '../../packages/myco/ui/src/components/agent/evaluation-helpers';
import type { EvaluationRunSummary } from '../../packages/myco/ui/src/hooks/use-agent';

function fakeRun(over: Partial<EvaluationRunSummary>): EvaluationRunSummary {
  return {
    id: 'run-x',
    agent_id: 'myco-agent',
    task: 'vault-evolve',
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

const ALL_COLUMNS: ReadonlyArray<ColumnKey> = [
  'runtime',
  'reasoning',
  'model',
  'status',
  'turns',
  'tokens',
  'cost',
  'duration',
  'writes',
  'costPerWrite',
];

describe('deriveRunReasoning', () => {
  it('returns the persisted reasoning_level when set', () => {
    expect(deriveRunReasoning(fakeRun({ reasoning_level: 'high' }))).toBe('high');
  });

  it('returns the task-default sentinel when null', () => {
    expect(deriveRunReasoning(fakeRun({ reasoning_level: null }))).toBe(TASK_DEFAULT_LABEL);
  });
});

describe('deriveCellLabel', () => {
  it('returns "default" when every axis is defaulted', () => {
    expect(deriveCellLabel({ runtime: null, reasoningLevel: undefined, model: null })).toBe('default');
  });

  it('omits defaulted axes from the label', () => {
    expect(
      deriveCellLabel({ runtime: 'claude-sdk', reasoningLevel: undefined, model: null }),
    ).toBe('claude-sdk');
  });

  it('joins concrete values with " / "', () => {
    expect(
      deriveCellLabel({ runtime: 'claude-sdk', reasoningLevel: 'high', model: 'sonnet-4.7' }),
    ).toBe('claude-sdk / high / sonnet-4.7');
  });

  it('treats the TASK_DEFAULT sentinel as a default, not a concrete value', () => {
    expect(
      deriveCellLabel({ runtime: TASK_DEFAULT_LABEL, reasoningLevel: 'high', model: null }),
    ).toBe('high');
  });
});

describe('computeCostPerWrite', () => {
  it('returns cost / writes rounded to 4 decimals', () => {
    expect(computeCostPerWrite(0.01, 4)).toBeCloseTo(0.0025, 6);
  });

  it('returns null when writes is zero', () => {
    expect(computeCostPerWrite(0.01, 0)).toBeNull();
  });

  it('returns null when cost is null', () => {
    expect(computeCostPerWrite(null, 4)).toBeNull();
  });
});

describe('computeDeltas', () => {
  it('hides fields when no run has a usable value', () => {
    const runs = [fakeRun({ id: 'a' })]; // no cost, no writes, no duration
    const d = computeDeltas(runs, [undefined]);
    expect(d.cheapest).toBeNull();
    expect(d.mostWrites).toBeNull();
    expect(d.fastest).toBeNull();
    expect(d.cheapestPct).toBeNull();
  });

  it('finds cheapest, most writes, and fastest across runs', () => {
    const runs = [
      fakeRun({
        id: 'a', runtime: 'claude-sdk', model: 'sonnet',
        cost_usd: 0.010, duration_ms: 5_000,
        write_intents: { total: 2, by_tool: { vault_create_spore: 2 } },
      }),
      fakeRun({
        id: 'b', runtime: 'openai-agents', model: 'gpt-5',
        cost_usd: 0.020, duration_ms: 3_000,
        write_intents: { total: 6, by_tool: { vault_create_spore: 4, vault_write_skill: 2 } },
      }),
    ];
    const d = computeDeltas(runs, ['low', 'high']);
    expect(d.cheapest?.run.id).toBe('a');
    expect(d.cheapestPct).toBe(50); // 0.010 / 0.020
    expect(d.mostWrites?.run.id).toBe('b');
    expect(d.fastest?.run.id).toBe('b');
  });
});

describe('formatWriteIntentsByTool', () => {
  it('returns an empty string for an empty map', () => {
    expect(formatWriteIntentsByTool({})).toBe('');
  });

  it('shortens tool names by taking the trailing token after the last underscore', () => {
    expect(
      formatWriteIntentsByTool({ vault_create_spore: 4, vault_write_skill: 1 }),
    ).toBe('spore×4, skill×1');
  });

  it('keeps the full name when the short form would be ambiguous (< 3 chars)', () => {
    expect(formatWriteIntentsByTool({ sync_up: 2 })).toBe('sync_up×2');
  });
});

describe('sumPhaseTurns', () => {
  it('returns null for missing or malformed input', () => {
    expect(sumPhaseTurns(null)).toBeNull();
    expect(sumPhaseTurns('not-json')).toBeNull();
    expect(sumPhaseTurns('{}')).toBeNull();
  });

  it('sums turnsUsed across phases', () => {
    const raw = JSON.stringify({ phases: [{ turnsUsed: 3 }, { turnsUsed: 2 }, {}] });
    expect(sumPhaseTurns(raw)).toBe(5);
  });

  it('returns null when no phase has a numeric turnsUsed', () => {
    const raw = JSON.stringify({ phases: [{}, {}] });
    expect(sumPhaseTurns(raw)).toBeNull();
  });
});

describe('selectVisibleColumns', () => {
  it('returns every candidate when there are fewer than 2 runs', () => {
    // With <2 runs the toggle is meaningless; the caller hides it and we
    // return the full candidate set defensively.
    expect(selectVisibleColumns([], ALL_COLUMNS)).toEqual(new Set(ALL_COLUMNS));
    expect(selectVisibleColumns([fakeRun({})], ALL_COLUMNS)).toEqual(new Set(ALL_COLUMNS));
  });

  it('hides columns that are identical across all rows', () => {
    const runs = [
      fakeRun({ id: 'a', runtime: 'claude-sdk', reasoning_level: 'low', model: 'sonnet' }),
      fakeRun({ id: 'b', runtime: 'claude-sdk', reasoning_level: 'high', model: 'sonnet' }),
    ];
    const visible = selectVisibleColumns(runs, ALL_COLUMNS);
    expect(visible.has('runtime')).toBe(false); // identical
    expect(visible.has('model')).toBe(false); // identical
    expect(visible.has('reasoning')).toBe(true); // varying
    // Status is always visible even if uniform.
    expect(visible.has('status')).toBe(true);
  });

  it('always keeps status visible even when uniform', () => {
    const runs = [
      fakeRun({ id: 'a', status: 'completed', reasoning_level: 'low' }),
      fakeRun({ id: 'b', status: 'completed', reasoning_level: 'high' }),
    ];
    const visible = selectVisibleColumns(runs, ['status', 'reasoning']);
    expect(visible.has('status')).toBe(true);
    expect(visible.has('reasoning')).toBe(true);
  });

  it('treats differing numeric columns as varying', () => {
    const runs = [
      fakeRun({ id: 'a', cost_usd: 0.010, tokens_used: 1000 }),
      fakeRun({ id: 'b', cost_usd: 0.020, tokens_used: 1000 }),
    ];
    const visible = selectVisibleColumns(runs, ['cost', 'tokens']);
    expect(visible.has('cost')).toBe(true);
    expect(visible.has('tokens')).toBe(false);
  });
});

describe('buildPhaseBreakdown', () => {
  it('produces a synthetic "run" row when usage_data has no phases', () => {
    const run = fakeRun({
      id: 'r1',
      reasoning_level: 'high',
      model: 'sonnet-4.7',
      tokens_used: 1234,
      cost_usd: 0.05,
      duration_ms: 4_000,
    });
    const rows = buildPhaseBreakdown(run);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'run',
      reasoning: 'high',
      model: 'sonnet-4.7',
      tokensUsed: 1234,
      costUsd: 0.05,
      durationMs: 4_000,
    });
  });

  it('emits one row per phase with per-phase values', () => {
    const usage = JSON.stringify({
      phases: [
        { name: 'prepare', turnsUsed: 3, tokensUsed: 500, costUsd: 0.01, usage: { durationMs: 1_500 } },
        { name: 'digest', turnsUsed: 5, tokensUsed: 900, costUsd: 0.02, usage: { durationMs: 3_000 } },
      ],
    });
    const run = fakeRun({
      reasoning_level: 'default',
      model: 'sonnet',
      usage_data: usage,
    });
    const rows = buildPhaseBreakdown(run);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'prepare', turnsUsed: 3, tokensUsed: 500, costUsd: 0.01, durationMs: 1_500 });
    expect(rows[1]).toMatchObject({ name: 'digest', turnsUsed: 5, tokensUsed: 900 });
  });

  it('prefers phase-level overrides over run-level reasoning/model', () => {
    const usage = JSON.stringify({ phases: [{ name: 'prepare' }, { name: 'digest' }] });
    const run = fakeRun({
      reasoning_level: 'low',
      model: 'sonnet',
      usage_data: usage,
      execution_overrides: {
        phases: {
          digest: { reasoningLevel: 'high', model: 'opus' },
        },
      },
    });
    const rows = buildPhaseBreakdown(run);
    expect(rows[0]).toMatchObject({ name: 'prepare', reasoning: 'low', model: 'sonnet' });
    expect(rows[1]).toMatchObject({ name: 'digest', reasoning: 'high', model: 'opus' });
  });

  it('falls back to null (task default) when neither run nor phase sets a value', () => {
    const usage = JSON.stringify({ phases: [{ name: 'prepare' }] });
    const run = fakeRun({
      reasoning_level: null,
      model: null,
      usage_data: usage,
    });
    const rows = buildPhaseBreakdown(run);
    expect(rows[0].reasoning).toBeNull();
    expect(rows[0].model).toBeNull();
  });

  it('tolerates malformed usage_data by emitting the synthetic row', () => {
    const run = fakeRun({ usage_data: 'not-json', tokens_used: 100 });
    const rows = buildPhaseBreakdown(run);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('run');
    expect(rows[0].tokensUsed).toBe(100);
  });
});

describe('countPhaseOverrides', () => {
  it('returns 0 when execution_overrides is null', () => {
    expect(countPhaseOverrides(fakeRun({ execution_overrides: null }))).toBe(0);
  });

  it('returns 0 when phases is absent', () => {
    expect(
      countPhaseOverrides(fakeRun({ execution_overrides: { reasoningLevel: 'high' } })),
    ).toBe(0);
  });

  it('returns the phase count when phases is a non-empty object', () => {
    expect(
      countPhaseOverrides(
        fakeRun({
          execution_overrides: {
            phases: { prepare: { reasoningLevel: 'low' }, digest: { model: 'opus' } },
          },
        }),
      ),
    ).toBe(2);
  });
});

describe('formatPhaseOverrideTooltip', () => {
  it('returns an empty string when there are no overrides', () => {
    expect(formatPhaseOverrideTooltip(fakeRun({ execution_overrides: null }))).toBe('');
  });

  it('formats each phase override with reasoning and model bits', () => {
    const tooltip = formatPhaseOverrideTooltip(fakeRun({
      execution_overrides: {
        phases: {
          prepare: { reasoningLevel: 'high' },
          digest: { model: 'opus' },
        },
      },
    }));
    expect(tooltip).toContain('prepare: high');
    expect(tooltip).toContain('digest: model=opus');
  });
});
