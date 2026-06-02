/**
 * Grove-default reasoning-tier resolution.
 *
 * `applyTaskConfigOverrides` is the consumer of the grove-wide
 * `agent.reasoningLevel` (added alongside the Settings → Agent "Default
 * reasoning profile" control). These tests lock the precedence so the grove
 * default fills ONLY when neither the per-task override nor the task
 * definition's own reasoning level is set, and never shadows either.
 *
 * Precedence (highest first):
 *   1. per-task override   — agent.tasks[name].reasoningLevel
 *   2. task's own level    — the task definition's intrinsic reasoningLevel
 *   3. grove default       — agent.reasoningLevel
 *   4. unset → the executor's built-in `default` tier
 */
import { describe, it, expect } from 'bun:test';
import { applyTaskConfigOverrides } from '@myco/agent/config-resolver';
import type { EffectiveConfig } from '@myco/agent/types';
import type { TaskProviderOverride } from '@myco/config/schema';

const HARNESS = 'claude-sdk' as const;

function baseConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    agentId: 'myco',
    harness: HARNESS,
    model: 'claude-sonnet-4-6',
    maxTurns: 10,
    timeoutSeconds: 600,
    systemPromptPath: '/dev/null',
    tools: [],
    taskName: 'cortex-instructions',
    taskDisplayName: 'Cortex Instructions',
    taskPrompt: '',
    ...overrides,
  };
}

describe('applyTaskConfigOverrides — grove-default reasoning tier', () => {
  it('fills the grove default when neither the task config nor the definition sets a level', () => {
    const result = applyTaskConfigOverrides(baseConfig(), undefined, HARNESS, 'high');
    expect(result.reasoningLevel).toBe('high');
  });

  it('leaves reasoningLevel unset when there is no grove default and no task level', () => {
    const result = applyTaskConfigOverrides(baseConfig(), undefined, HARNESS, undefined);
    expect(result.reasoningLevel).toBeUndefined();
  });

  it('lets a per-task override win over the grove default', () => {
    const taskConfig = { reasoningLevel: 'low' } as TaskProviderOverride;
    const result = applyTaskConfigOverrides(baseConfig(), taskConfig, HARNESS, 'high');
    expect(result.reasoningLevel).toBe('low');
  });

  it('lets the task definition\'s own level win over the grove default', () => {
    const result = applyTaskConfigOverrides(
      baseConfig({ reasoningLevel: 'high' }),
      undefined,
      HARNESS,
      'low',
    );
    expect(result.reasoningLevel).toBe('high');
  });

  it('still applies a per-task override over the definition level', () => {
    const taskConfig = { reasoningLevel: 'low' } as TaskProviderOverride;
    const result = applyTaskConfigOverrides(
      baseConfig({ reasoningLevel: 'high' }),
      taskConfig,
      HARNESS,
      undefined,
    );
    expect(result.reasoningLevel).toBe('low');
  });

  it('mirrors a per-task override into execution but does NOT rewrite execution for the grove default', () => {
    const withExecution = baseConfig({ execution: { reasoningLevel: undefined } });

    // Grove default: execution block left untouched (executor reads
    // config.reasoningLevel when execution has none).
    const groveFilled = applyTaskConfigOverrides(withExecution, undefined, HARNESS, 'high');
    expect(groveFilled.reasoningLevel).toBe('high');
    expect(groveFilled.execution?.reasoningLevel).toBeUndefined();

    // Per-task override: execution mirror is rewritten.
    const overridden = applyTaskConfigOverrides(
      withExecution,
      { reasoningLevel: 'low' } as TaskProviderOverride,
      HARNESS,
      'high',
    );
    expect(overridden.execution?.reasoningLevel).toBe('low');
  });
});
