/**
 * Tests that executePhase emits phaseStart before dispatch and phaseEnd
 * at both the success and failure return points, using ctx.hooks.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type {
  EffectiveConfig,
  PhaseDefinition,
  RuntimeUsage,
  HarnessId,
} from '@myco/agent/types.js';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import type { PhaseStartEvent, PhaseEndEvent } from '@myco/agent/harness/hooks.js';
import type { PhaseLoopContext } from '@myco/agent/phase-loop.js';

let executeBehavior: 'success' | 'error' = 'success';

const DEFAULT_USAGE: RuntimeUsage = {
  requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20,
  reasoningTokens: 0, cachedTokens: 0, durationMs: 5,
};

const fakeHarness: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  async execute(_input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    if (executeBehavior === 'error') {
      throw new HarnessExecutionError('boom', { usage: DEFAULT_USAGE, kind: 'other' });
    }
    return { finalText: 'ok', turnsUsed: 1, usage: DEFAULT_USAGE, sessionRef: 'session-1' };
  },
  supports: () => false,
  classifyError: () => 'unknown',
};

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => fakeHarness,
}));

describe('executePhase hook emission', () => {
  beforeEach(() => {
    executeBehavior = 'success';
  });

  function buildCtx(hooksOverrides: Partial<NonNullable<PhaseLoopContext['hooks']>>): PhaseLoopContext {
    return {
      config: { harness: 'claude-sdk' as HarnessId, taskName: 'test-task' } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
      hooks: hooksOverrides as any,
    } as PhaseLoopContext;
  }

  it('emits phaseStart before dispatch and phaseEnd with status completed on success', async () => {
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const starts: PhaseStartEvent[] = [];
    const ends: PhaseEndEvent[] = [];
    const ctx = buildCtx({
      phaseStart: (e) => { starts.push(e); },
      phaseEnd: (e) => { ends.push(e); },
    });
    const phase: PhaseDefinition = { name: 'gather', prompt: '', tools: [], maxTurns: 5, required: true };

    await executePhase({
      ctx, phasePrompt: 'do the thing', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(starts).toHaveLength(1);
    expect(starts[0].phaseName).toBe('gather');
    expect(starts[0].required).toBe(true);
    expect(ends).toHaveLength(1);
    expect(ends[0].status).toBe('completed');
    expect(ends[0].turnsUsed).toBe(1);
  });

  it('emits phaseEnd with status failed when the harness throws', async () => {
    executeBehavior = 'error';
    const ends: PhaseEndEvent[] = [];
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const ctx = buildCtx({ phaseEnd: (e) => { ends.push(e); } });
    const phase: PhaseDefinition = { name: 'gather', prompt: '', tools: [], maxTurns: 5, required: false };

    await executePhase({
      ctx, phasePrompt: 'do the thing', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(ends).toHaveLength(1);
    expect(ends[0].status).toBe('failed');
  });

  it('does not throw when ctx.hooks is undefined (backward compat)', async () => {
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const ctx = { ...buildCtx({}), hooks: undefined } as PhaseLoopContext;
    const phase: PhaseDefinition = { name: 'gather', prompt: '', tools: [], maxTurns: 5, required: false };

    const result = await executePhase({
      ctx, phasePrompt: 'do the thing', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });
    expect(result.status).toBe('completed');
  });
});
