import { describe, expect, test } from 'bun:test';
import { resolvePhaseExecution } from './phase-resolver.js';
import type { EffectiveConfig, PhaseDefinition } from './types.js';

/**
 * Regression guard for the reasoningLevel plumbing gap this plan closes:
 * `resolvePhaseExecution` already returned `reasoningLevel` before this
 * change, but every caller in phase-loop.ts discarded it after computing
 * `model`. This test locks that `resolvePhaseExecution` itself still
 * returns the resolved level (the phase-loop.ts wiring that now forwards
 * it is exercised via the harness tests in Task 2/3, since phase-loop.ts
 * has no isolated unit-test seam for its internal wave loop).
 */
describe('resolvePhaseExecution reasoningLevel passthrough', () => {
  const basePhase: PhaseDefinition = {
    name: 'extract',
    prompt: 'test',
    tools: [],
    maxTurns: 10,
    required: true,
  };

  const baseConfig: EffectiveConfig = {
    agentId: 'agent-1',
    harness: 'claude-sdk',
    model: 'claude-sonnet-4-6',
    maxTurns: 10,
    timeoutSeconds: 60,
    systemPromptPath: 'prompt.md',
    tools: [],
    taskName: 'test-task',
    taskDisplayName: 'Test Task',
    taskPrompt: 'test',
  };

  test('phase-level reasoningLevel is returned unchanged for the harness to consume', () => {
    const phase: PhaseDefinition = { ...basePhase, reasoningLevel: 'high' };
    const resolved = resolvePhaseExecution(phase, undefined, baseConfig, undefined);
    expect(resolved.reasoningLevel).toBe('high');
  });

  test('run override reasoningLevel wins over phase YAML', () => {
    const phase: PhaseDefinition = { ...basePhase, reasoningLevel: 'low' };
    const resolved = resolvePhaseExecution(
      phase,
      { executionOverrides: { phases: { extract: { reasoningLevel: 'high' } } } },
      baseConfig,
      undefined,
    );
    expect(resolved.reasoningLevel).toBe('high');
  });

  test('falls back to config.reasoningLevel when nothing else is set', () => {
    const resolved = resolvePhaseExecution(
      basePhase,
      undefined,
      { ...baseConfig, reasoningLevel: 'low' },
      undefined,
    );
    expect(resolved.reasoningLevel).toBe('low');
  });
});
