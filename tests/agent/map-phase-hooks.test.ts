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

// A distinct MapPhaseResult for the "sink blocked" scenario: itemCount > 0,
// written === 0, no provider outage — mapResultToPhaseStatus classifies
// this as 'failed' purely from the counts (see phase-loop.ts), which is
// the SAME mechanism a real blocked sink call drives (throw -> isError ->
// sink capture ok:false -> failed++).
const fakeBlockedMapResult: MapPhaseResult = {
  itemCount: 2, written: 0, skipped: 0, failed: 2, abandoned: 0,
  skipReasons: {}, writeAfterThrow: 0, providerUnavailable: false, unavailable: 0,
  usage: { requests: 2, inputTokens: 20, outputTokens: 20, totalTokens: 40, reasoningTokens: 0, cachedTokens: 0, durationMs: 20 },
};

let executeMapPhaseBehavior: 'success' | 'error' | 'blocked' | 'flagged-mixed' = 'success';

function pushFlagIntoCapturedAccumulator(): void {
  // Simulate what a real blocked sink call does: wrapToolWithSemanticCheck
  // (tools.ts) pushes into the flaggedWritesAccumulator threaded through
  // createVaultTools's options — captured below via createVaultToolsCalls.
  const lastCall = createVaultToolsCalls[createVaultToolsCalls.length - 1] as
    [string, string, { flaggedWritesAccumulator?: Array<{ toolName: string; reason: string | null }> }];
  lastCall[2]?.flaggedWritesAccumulator?.push({
    toolName: 'vault_mark_processed',
    reason: 'batch_id does not appear in this phase\'s declared scope',
  });
}

mock.module('@myco/agent/map-phase.js', () => ({
  executeMapPhase: async () => {
    if (executeMapPhaseBehavior === 'error') {
      throw new Error('map phase failed');
    }
    if (executeMapPhaseBehavior === 'blocked') {
      pushFlagIntoCapturedAccumulator();
      return fakeBlockedMapResult;
    }
    if (executeMapPhaseBehavior === 'flagged-mixed') {
      // Mixed batch: other items DID write (written > 0), so the count-based
      // mapResultToPhaseStatus alone would classify this phase 'completed' —
      // only the flagged-accumulator conversion can fail it.
      pushFlagIntoCapturedAccumulator();
      return fakeMapResult;
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

  it('threads semantic-check options into createVaultTools when semanticWriteCheckEnabled is on (Fix 5 regression)', async () => {
    // Regression: runMapPhaseAdapter's createVaultTools call passed hooks/
    // hookContext but not semanticCheckEnabled/phasePurpose/harnessId/
    // model/classifierReasoningLevel/provider/flaggedWritesAccumulator —
    // so the semantic check was silently inert for map-phase sinks.
    const { executePhase } = await import('@myco/agent/phase-loop.js');

    const ctx: PhaseLoopContext = {
      config: {
        harness: 'claude-sdk' as HarnessId,
        taskName: 'test-task',
        semanticWriteCheckEnabled: true,
        classifierReasoningLevel: 'high',
      } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
    } as PhaseLoopContext;

    const phase: PhaseDefinition = {
      name: 'map-gather', prompt: 'Do the narrow thing.', tools: [], maxTurns: 5, required: true, mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'sink_tool', argMap: {} },
    };

    await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase,
      provider: { type: 'anthropic' },
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(createVaultToolsCalls).toHaveLength(1);
    const [, , options] = createVaultToolsCalls[0] as [string, string, {
      semanticCheckEnabled?: boolean;
      harnessId?: string;
      model?: string;
      classifierReasoningLevel?: string;
      provider?: unknown;
      phasePurpose?: { name?: string; promptExcerpt?: string };
      flaggedWritesAccumulator?: unknown[];
    }];
    expect(options.semanticCheckEnabled).toBe(true);
    expect(options.harnessId).toBe('claude-sdk');
    expect(options.model).toBe('claude-sonnet-4-6');
    expect(options.classifierReasoningLevel).toBe('high');
    expect(options.provider).toEqual({ type: 'anthropic' });
    expect(options.phasePurpose?.name).toBe('map-gather');
    expect(options.phasePurpose?.promptExcerpt).toBe('Do the narrow thing.');
    expect(options.flaggedWritesAccumulator).toEqual([]);
  });

  it('ends the phase as failed and emits phaseEnd exactly once when a map-phase sink is flagged (Fix 5 regression)', async () => {
    executeMapPhaseBehavior = 'blocked';
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const ends: PhaseEndEvent[] = [];

    const ctx: PhaseLoopContext = {
      config: {
        harness: 'claude-sdk' as HarnessId,
        taskName: 'test-task',
        semanticWriteCheckEnabled: true,
      } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
      hooks: {
        phaseEnd: (e) => { ends.push(e); },
      },
    } as PhaseLoopContext;

    const phase: PhaseDefinition = {
      name: 'map-sink', prompt: 'Mark items processed.', tools: [], maxTurns: 5, required: true, mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'vault_mark_processed', argMap: {} },
    };

    const result = await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('semanticCheckBlocked=1');
    expect(result.summary).toContain('vault_mark_processed');
    expect(ends).toHaveLength(1);
    expect(ends[0].status).toBe('failed');
  });

  it('fails a MIXED batch when a sink call was flagged, even though other items wrote (Fix 5 regression)', async () => {
    // The count-based mapResultToPhaseStatus would classify this batch
    // 'completed' (written=3) — only the flagged-accumulator conversion in
    // runMapPhaseAdapter (mirroring executePhase's snapshotFlaggedWrites
    // contract: ANY flagged destructive write fails the phase) can fail it.
    // Also pins single phaseEnd emission (no double-fire) and the
    // reason-free summary (Fix 6a parity on the map path).
    executeMapPhaseBehavior = 'flagged-mixed';
    const { executePhase } = await import('@myco/agent/phase-loop.js');
    const ends: PhaseEndEvent[] = [];

    const ctx: PhaseLoopContext = {
      config: {
        harness: 'claude-sdk' as HarnessId,
        taskName: 'test-task',
        semanticWriteCheckEnabled: true,
      } as EffectiveConfig,
      systemPrompt: 'system',
      vaultContext: 'vault context',
      agentId: 'agent-1',
      runId: 'run-1',
      checkpointState: { schemaVersion: 2, harness: 'claude-sdk' as HarnessId, phases: {} },
      hooks: {
        phaseEnd: (e) => { ends.push(e); },
      },
    } as PhaseLoopContext;

    const phase: PhaseDefinition = {
      name: 'map-sink-mixed', prompt: 'Mark items processed.', tools: [], maxTurns: 5, required: true, mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'vault_mark_processed', argMap: {} },
    };

    const result = await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(result.status).toBe('failed');
    expect(result.semanticCheckBlocked).toBe(true);
    expect(result.summary).toContain('semanticCheckBlocked=1');
    expect(result.summary).toContain('vault_mark_processed');
    // Reason-free summary — the classifier's verbatim reason must not
    // reach text a later phase prompt can see.
    expect(result.summary).not.toContain('does not appear in this phase');
    expect(ends).toHaveLength(1);
    expect(ends[0].status).toBe('failed');
  });
});
