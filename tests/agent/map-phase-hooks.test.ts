/**
 * Tests that runMapPhaseAdapter emits one phaseStart/phaseEnd pair around
 * the whole map-phase batch (not per-item), and that it threads hooks/
 * hookContext into the createVaultTools call so per-item tool calls get
 * preToolUse/postToolUse too.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { EffectiveConfig, PhaseDefinition, HarnessId, MapPhaseResult } from '@myco/agent/types.js';
import type { AgentHarness } from '@myco/agent/harness/types.js';
import type { PhaseStartEvent, PhaseEndEvent } from '@myco/agent/harness/hooks.js';
import type { PhaseLoopContext } from '@myco/agent/phase-loop.js';

const fakeMapResult: MapPhaseResult = {
  itemCount: 3, written: 3, skipped: 0, failed: 0, abandoned: 0,
  skipReasons: {}, writeAfterThrow: 0, providerUnavailable: false, unavailable: 0,
  usage: { requests: 3, inputTokens: 30, outputTokens: 30, totalTokens: 60, reasoningTokens: 0, cachedTokens: 0, durationMs: 30 },
};

let executeMapPhaseBehavior: 'success' | 'error' = 'success';

mock.module('@myco/agent/map-phase.js', () => ({
  executeMapPhase: async () => {
    if (executeMapPhaseBehavior === 'error') {
      throw new Error('map phase failed');
    }
    return fakeMapResult;
  },
}));

const fakeHarness: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  execute: async () => { throw new Error('not used in this test'); },
  supports: () => false,
  classifyError: () => 'unknown',
};

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => fakeHarness,
}));

const createVaultToolsCalls: unknown[] = [];
mock.module('@myco/agent/tools.js', () => ({
  createVaultTools: (...args: unknown[]) => {
    createVaultToolsCalls.push(args);
    return [];
  },
}));

describe('runMapPhaseAdapter hook emission', () => {
  beforeEach(() => {
    executeMapPhaseBehavior = 'success';
    createVaultToolsCalls.length = 0;
  });

  it('emits exactly one phaseStart/phaseEnd pair for the whole batch, not per item', async () => {
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const starts: PhaseStartEvent[] = [];
    const ends: PhaseEndEvent[] = [];

    const ctx: PhaseLoopContext = {
      config: { harness: 'claude-sdk' as HarnessId, taskName: 'test-task' } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
      hooks: {
        phaseStart: (e) => { starts.push(e); },
        phaseEnd: (e) => { ends.push(e); },
      },
    } as PhaseLoopContext;

    const phase: PhaseDefinition = {
      name: 'map-gather', prompt: '', tools: [], maxTurns: 5, required: true, mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'sink_tool', argMap: {} },
    };

    await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(starts).toHaveLength(1);
    expect(starts[0].phaseName).toBe('map-gather');
    expect(ends).toHaveLength(1);
    expect(ends[0].phaseName).toBe('map-gather');
    expect(ends[0].status).toBe('completed');
    expect(ends[0].turnsUsed).toBe(3);

    expect(createVaultToolsCalls).toHaveLength(1);
    const [, , options] = createVaultToolsCalls[0] as [string, string, { hooks?: unknown; hookContext?: { phaseName?: string } }];
    expect(options.hooks).toBe(ctx.hooks);
    expect(options.hookContext?.phaseName).toBe('map-gather');
  });

  it('emits phaseEnd with status failed when executeMapPhase throws', async () => {
    executeMapPhaseBehavior = 'error';
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const starts: PhaseStartEvent[] = [];
    const ends: PhaseEndEvent[] = [];

    const ctx: PhaseLoopContext = {
      config: { harness: 'claude-sdk' as HarnessId, taskName: 'test-task' } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
      hooks: {
        phaseStart: (e) => { starts.push(e); },
        phaseEnd: (e) => { ends.push(e); },
      },
    } as PhaseLoopContext;

    const phase: PhaseDefinition = {
      name: 'map-gather', prompt: '', tools: [], maxTurns: 5, required: true, mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'sink_tool', argMap: {} },
    };

    const result = await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(starts).toHaveLength(1);
    expect(starts[0].phaseName).toBe('map-gather');
    expect(ends).toHaveLength(1);
    expect(ends[0].phaseName).toBe('map-gather');
    expect(ends[0].status).toBe('failed');
    expect(result.status).toBe('failed');
  });

  it('does not throw when ctx.hooks is undefined (backward compat)', async () => {
    const { executePhase } = await import('@myco/agent/phase-loop.js');

    const ctx: PhaseLoopContext = {
      config: { harness: 'claude-sdk' as HarnessId, taskName: 'test-task' } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
      hooks: undefined,
    } as PhaseLoopContext;

    const phase: PhaseDefinition = {
      name: 'map-gather', prompt: '', tools: [], maxTurns: 5, required: true, mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'sink_tool', argMap: {} },
    };

    const result = await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(result.status).toBe('completed');
  });
});
