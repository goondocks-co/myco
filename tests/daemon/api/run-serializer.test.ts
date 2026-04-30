/**
 * Poison-row resilience tests for the agent-runs API serializer.
 *
 * Historical rows can carry malformed JSON in `cost_data`, `usage_data`, or
 * `execution_overrides` (corruption, partial writes, a bug in an older
 * branch). The serializer MUST pass those values through cleanly rather
 * than crashing the list endpoint and hiding every other row.
 */

import { describe, it, expect } from 'bun:test';
import { serializeRun } from '@myco/daemon/api/run-serializer.js';
import type { RunRow } from '@myco/db/queries/runs.js';

function baseRun(overrides: Partial<RunRow>): RunRow {
  return {
    id: 'run-1',
    agent_id: 'myco-agent',
    task: 'test',
    instruction: null,
    status: 'completed',
    harness: null,
    provider: null,
    model: null,
    session_ref: null,
    resumable: 0,
    resume_status: null,
    resume_mode: null,
    resumed_at: null,
    checkpoints: null,
    usage_data: null,
    started_at: 0,
    completed_at: 0,
    tokens_used: 0,
    cost_usd: 0,
    actual_cost_usd: 0,
    estimated_cost_usd: null,
    cost_source: 'unavailable',
    cost_data: null,
    actions_taken: null,
    error: null,
    dry_run: false,
    evaluation_id: null,
    reasoning_level: null,
    execution_overrides: null,
    ...overrides,
  };
}

describe('serializeRun — poison-row resilience', () => {
  it('passes malformed cost_data string through without crashing', () => {
    const row = baseRun({ cost_data: '{not-json' });
    const out = serializeRun(row);
    expect(out.cost_data).toBe('{not-json');
  });

  it('passes malformed usage_data string through without crashing', () => {
    const row = baseRun({ usage_data: '{usage:broken' });
    const out = serializeRun(row);
    expect(out.usage_data).toBe('{usage:broken');
  });

  it('tolerates null execution_overrides (the common case)', () => {
    const row = baseRun({ execution_overrides: null });
    const out = serializeRun(row);
    expect(out.execution_overrides).toBeNull();
  });

  it('strips apiKey from nested provider overrides even on otherwise well-formed rows', () => {
    const row = baseRun({
      execution_overrides: {
        provider: { type: 'openai', apiKey: 'sk-secret' },
      },
    });
    const out = serializeRun(row);
    const providerOverride = (out.execution_overrides as Record<string, unknown>).provider as Record<string, unknown>;
    expect(providerOverride.type).toBe('openai');
    expect(providerOverride).not.toHaveProperty('apiKey');
  });

  it('builds an empty phase_checkpoints projection when checkpoints JSON is malformed', () => {
    const row = baseRun({ checkpoints: '{phases:not-real-json' });
    const out = serializeRun(row);
    expect(out.phase_checkpoints).toEqual([]);
  });
});
