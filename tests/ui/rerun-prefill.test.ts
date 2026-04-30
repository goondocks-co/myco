/**
 * Unit tests for `buildRerunPrefill` — the pure helper that seeds
 * RunTaskDialog from a source run when an operator clicks "Rerun with same
 * settings." The dialog itself has no React-Testing-Library harness; the
 * helper suite is the coverage bar for the feature's data flow.
 *
 * The helper's contract:
 *  - Copy task / instruction / dry_run across verbatim.
 *  - Extract recognized template-var values (session_id / batch_id /
 *    target_session) from the instruction, but only for keys that are
 *    actual template variables on the matching task prompt.
 *  - Coerce the wire-shape `execution_overrides` to the UI-internal shapes
 *    (snake_case ProviderConfig, PhaseOverride map).
 *  - Surface `hasAnyOverride` so the caller can auto-expand the Override
 *    section.
 *  - Flag the deleted-task edge case via `taskMissing`.
 */

import { describe, expect, it } from 'bun:test';
import { buildRerunPrefill } from '../../packages/myco/ui/src/components/agent/rerun-prefill';
import type { RunRow, TaskRow } from '../../packages/myco/ui/src/hooks/use-agent';

function makeRun(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    agent_id: 'agent-default',
    task: 'vault-evolve',
    instruction: null,
    status: 'completed',
    harness: null,
    provider: null,
    model: null,
    session_ref: null,
    resumable: false,
    resume_status: null,
    resume_mode: null,
    resumed_at: null,
    checkpoints: null,
    usage_data: null,
    started_at: 1_700_000_000,
    completed_at: 1_700_000_010,
    tokens_used: 100,
    cost_usd: 0.01,
    actual_cost_usd: 0.01,
    estimated_cost_usd: null,
    cost_source: 'actual',
    cost_data: null,
    actions_taken: null,
    error: null,
    dry_run: false,
    evaluation_id: null,
    reasoning_level: null,
    execution_overrides: null,
    ...over,
  };
}

function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  return {
    name: 'vault-evolve',
    displayName: 'Full intelligence',
    description: 'Full intelligence pass',
    agent: 'myco',
    prompt: 'Process session {{session_id}} and update the digest.',
    isDefault: false,
    ...over,
  };
}

describe('buildRerunPrefill', () => {
  it('copies task, instruction, dry_run with no overrides', () => {
    const run = makeRun({ instruction: 'plain reminder', dry_run: true });
    const prefill = buildRerunPrefill(run, [makeTask()]);
    expect(prefill.taskName).toBe('vault-evolve');
    expect(prefill.instruction).toBe('plain reminder');
    expect(prefill.dryRun).toBe(true);
    expect(prefill.hasAnyOverride).toBe(false);
    expect(prefill.harness).toBeUndefined();
    expect(prefill.reasoningLevel).toBeUndefined();
    expect(prefill.model).toBeUndefined();
    expect(prefill.provider).toBeUndefined();
    expect(prefill.phaseOverrides).toEqual({});
    expect(prefill.taskMissing).toBe(false);
  });

  it('seeds full override shape when source has harness/reasoning/model/provider/phases', () => {
    const run = makeRun({
      instruction: 'just rerun',
      execution_overrides: {
        harness: 'openai-agents',
        reasoningLevel: 'high',
        model: 'gpt-5',
        provider: {
          type: 'openai',
          model: 'gpt-5',
          reasoningMap: { low: 'gpt-4', default: 'gpt-5', high: 'gpt-5-thinking' },
        },
        phases: {
          extract: {
            reasoningLevel: 'high',
            model: 'gpt-5-thinking',
            maxTurns: 12,
          },
          digest: {
            provider: { type: 'anthropic', model: 'claude-sonnet-4-5' },
          },
        },
      },
    });
    const prefill = buildRerunPrefill(run, [makeTask()]);
    expect(prefill.harness).toBe('openai-agents');
    expect(prefill.reasoningLevel).toBe('high');
    expect(prefill.model).toBe('gpt-5');
    expect(prefill.provider).toEqual({
      type: 'openai',
      model: 'gpt-5',
      reasoning_map: { low: 'gpt-4', default: 'gpt-5', high: 'gpt-5-thinking' },
    });
    expect(prefill.phaseOverrides.extract).toEqual({
      model: 'gpt-5-thinking',
      maxTurns: 12,
    });
    expect(prefill.phaseOverrides.digest).toEqual({
      provider: { type: 'anthropic', model: 'claude-sonnet-4-5' },
    });
    expect(prefill.hasAnyOverride).toBe(true);
  });

  it('parses recognized template-var values from the instruction when the task declares them', () => {
    const run = makeRun({
      instruction: 'session_id: 36858a44-4ef7-4448-96e8-382e992e8ba4',
    });
    const task = makeTask({
      prompt: 'Summarize session {{session_id}} and report findings.',
    });
    const prefill = buildRerunPrefill(run, [task]);
    expect(prefill.varValues).toEqual({
      session_id: '36858a44-4ef7-4448-96e8-382e992e8ba4',
    });
  });

  it('drops recognized keys that are not template variables on the matching task', () => {
    const run = makeRun({
      instruction: 'batch_id=batch-1\nsession_id: abc-123',
    });
    // Task only declares session_id as a template var; batch_id must be dropped.
    const task = makeTask({
      prompt: 'Summarize session {{session_id}}.',
    });
    const prefill = buildRerunPrefill(run, [task]);
    expect(prefill.varValues).toEqual({ session_id: 'abc-123' });
    expect(prefill.varValues.batch_id).toBeUndefined();
  });

  it('flags taskMissing when the source task is not in the task list', () => {
    const run = makeRun({ task: 'removed-task' });
    const prefill = buildRerunPrefill(run, [makeTask({ name: 'vault-evolve' })]);
    expect(prefill.taskMissing).toBe(true);
    expect(prefill.taskName).toBe('removed-task');
  });

  it('treats null execution_overrides identically to a run with no overrides', () => {
    const run = makeRun({ execution_overrides: null });
    const prefill = buildRerunPrefill(run, [makeTask()]);
    expect(prefill.hasAnyOverride).toBe(false);
    expect(prefill.harness).toBeUndefined();
    expect(prefill.provider).toBeUndefined();
    expect(prefill.phaseOverrides).toEqual({});
  });

  it('keeps recognized-key parsing when the task is missing (best-effort fallback)', () => {
    const run = makeRun({
      task: 'gone',
      instruction: 'session_id: keep-me',
    });
    const prefill = buildRerunPrefill(run, []);
    expect(prefill.taskMissing).toBe(true);
    expect(prefill.varValues).toEqual({ session_id: 'keep-me' });
  });

  it('ignores unknown harness / reasoning values and leaves overrides undefined', () => {
    const run = makeRun({
      execution_overrides: {
        harness: 'bogus',
        reasoningLevel: 'extreme',
        model: 'gpt-5',
      },
    });
    const prefill = buildRerunPrefill(run, [makeTask()]);
    expect(prefill.harness).toBeUndefined();
    expect(prefill.reasoningLevel).toBeUndefined();
    expect(prefill.model).toBe('gpt-5');
    // Model alone still counts as an override.
    expect(prefill.hasAnyOverride).toBe(true);
  });

  it('parses quoted template-var values from the instruction', () => {
    const run = makeRun({
      instruction: 'session_id: "36858a44-4ef7-4448-96e8-382e992e8ba4"',
    });
    const task = makeTask({
      prompt: 'Summarize session {{session_id}}.',
    });
    const prefill = buildRerunPrefill(run, [task]);
    expect(prefill.varValues).toEqual({
      session_id: '36858a44-4ef7-4448-96e8-382e992e8ba4',
    });
  });

  it('ignores empty phase entries (no editable field set)', () => {
    const run = makeRun({
      execution_overrides: {
        phases: {
          extract: { reasoningLevel: 'high' }, // not editable by PhaseConfigRow
        },
      },
    });
    const prefill = buildRerunPrefill(run, [makeTask()]);
    expect(prefill.phaseOverrides).toEqual({});
    expect(prefill.hasAnyOverride).toBe(false);
  });
});
