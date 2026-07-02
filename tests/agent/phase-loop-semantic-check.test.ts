/**
 * Proves the semantic-check config gate reaches the per-phase toolSurface
 * handed to the harness. Task 2b snapshots
 * config.semanticWriteCheckEnabled and config.classifierReasoningLevel
 * onto EffectiveConfig; this test proves phase-loop.ts reads them (plus
 * the phase's resolved harness id/model) into
 * toolSurface.semanticCheckEnabled/harnessId/model/classifierReasoningLevel
 * — the wiring wrapToolWithSemanticCheck (tools.ts, Task 7) needs to
 * actually run.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { EffectiveConfig, PhaseDefinition, RuntimeUsage, HarnessId } from '@myco/agent/types.js';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import type { RunCheckpointState } from '@myco/agent/executor-state.js';

const DEFAULT_USAGE: RuntimeUsage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 200,
  totalTokens: 300,
  reasoningTokens: 0,
  cachedTokens: 0,
  durationMs: 10,
};

let capturedExecuteInputs: HarnessExecuteInput[] = [];

const fakeRuntime: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    capturedExecuteInputs.push(input);
    return { finalText: 'ok', turnsUsed: 1, usage: DEFAULT_USAGE, sessionRef: 'session-1' };
  },
  supports: () => false,
};

/** Per-test override so a single test can swap in a different fake harness. */
let getAgentHarnessOverride: AgentHarness | undefined;

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => getAgentHarnessOverride ?? fakeRuntime,
}));

import { executePhasedQuery, type PhaseLoopContext } from '@myco/agent/phase-loop.js';

function baseConfig(phases?: PhaseDefinition[], extra: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    taskName: 'test-task',
    taskDisplayName: 'Test Task',
    taskPrompt: 'Do the thing.',
    systemPromptPath: 'prompts/system.md',
    harness: 'claude-sdk',
    model: 'claude-sonnet-4',
    maxTurns: 5,
    timeoutSeconds: 60,
    tools: [],
    ...(phases ? { phases } : {}),
    ...extra,
  } as EffectiveConfig;
}

function baseCheckpoint(): RunCheckpointState {
  return {
    harness: 'claude-sdk',
    phases: {},
  };
}

function baseContext(overrides: Partial<PhaseLoopContext> = {}): PhaseLoopContext {
  return {
    config: baseConfig(),
    systemPrompt: 'SYSTEM',
    vaultContext: 'VAULT CONTEXT',
    agentId: 'myco-agent',
    runId: 'run-123',
    instruction: undefined,
    checkpointState: baseCheckpoint(),
    ...overrides,
  } as PhaseLoopContext;
}

function phase(name: string, extra: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    name,
    prompt: 'Do a narrow, well-scoped thing.',
    tools: ['vault_mark_processed'],
    maxTurns: 1,
    required: true,
    ...extra,
  } as PhaseDefinition;
}

beforeEach(() => {
  capturedExecuteInputs = [];
  getAgentHarnessOverride = undefined;
});

describe('phase-loop semantic-check config threading', () => {
  it('passes semanticCheckEnabled + harnessId + model into the phase toolSurface when the config flag is on', async () => {
    const ctx = baseContext({
      config: baseConfig([phase('only-phase')], { semanticWriteCheckEnabled: true }),
    });

    await executePhasedQuery(ctx);

    expect(capturedExecuteInputs.length).toBeGreaterThan(0);
    const surface = capturedExecuteInputs[0].toolSurface as {
      semanticCheckEnabled?: boolean;
      harnessId?: string;
      model?: string;
    };
    expect(surface.semanticCheckEnabled).toBe(true);
    expect(surface.harnessId).toBe('claude-sdk');
    expect(typeof surface.model).toBe('string');
    expect(surface.model).toBe('claude-sonnet-4');
  });

  it('leaves semanticCheckEnabled falsy on the toolSurface when the config flag is off/absent', async () => {
    const ctx = baseContext({
      config: baseConfig([phase('only-phase')]),
    });

    await executePhasedQuery(ctx);

    expect(capturedExecuteInputs.length).toBeGreaterThan(0);
    const surface = capturedExecuteInputs[0].toolSurface as { semanticCheckEnabled?: boolean };
    expect(surface.semanticCheckEnabled).toBe(false);
  });

  it('passes classifierReasoningLevel into the phase toolSurface when set on the config', async () => {
    // Regression: config.classifierReasoningLevel (Task 2b's snapshot) was
    // never read into toolSurface, so the override silently never reached
    // the classifier — every call defaulted to 'low' regardless of what
    // was snapshotted on the run row.
    const ctx = baseContext({
      config: baseConfig([phase('only-phase')], {
        semanticWriteCheckEnabled: true,
        classifierReasoningLevel: 'high',
      }),
    });

    await executePhasedQuery(ctx);

    expect(capturedExecuteInputs.length).toBeGreaterThan(0);
    const surface = capturedExecuteInputs[0].toolSurface as { classifierReasoningLevel?: string };
    expect(surface.classifierReasoningLevel).toBe('high');
  });

  it('leaves classifierReasoningLevel undefined on the toolSurface when absent from config', async () => {
    const ctx = baseContext({
      config: baseConfig([phase('only-phase')], { semanticWriteCheckEnabled: true }),
    });

    await executePhasedQuery(ctx);

    expect(capturedExecuteInputs.length).toBeGreaterThan(0);
    const surface = capturedExecuteInputs[0].toolSurface as { classifierReasoningLevel?: string };
    expect(surface.classifierReasoningLevel).toBeUndefined();
  });

  it('allocates a flaggedWritesAccumulator on the toolSurface only when semanticWriteCheckEnabled is on', async () => {
    const onCtx = baseContext({
      config: baseConfig([phase('only-phase')], { semanticWriteCheckEnabled: true }),
    });
    await executePhasedQuery(onCtx);
    const onSurface = capturedExecuteInputs[0].toolSurface;
    expect(onSurface.flaggedWritesAccumulator).toBeDefined();
    expect(onSurface.flaggedWritesAccumulator).toEqual([]);

    capturedExecuteInputs = [];

    const offCtx = baseContext({
      config: baseConfig([phase('only-phase')]),
    });
    await executePhasedQuery(offCtx);
    const offSurface = capturedExecuteInputs[0].toolSurface;
    expect(offSurface.flaggedWritesAccumulator).toBeUndefined();
  });

  it('converts an otherwise-"completed" phase to "failed" when the flaggedWritesAccumulator is non-empty', async () => {
    // C2 regression: the claude-sdk SDK converts a tool handler's throw
    // into an isError MCP tool result returned to the MODEL — it never
    // reaches this harness.execute() call as a JS exception. A retrying
    // model can therefore complete the phase "successfully" immediately
    // after a blocked destructive write unless executePhase itself checks
    // the accumulator wrapToolWithSemanticCheck (tools.ts) records into.
    // fakeRuntime simulates that: it observes the accumulator handed to it
    // on the toolSurface and pushes a flagged-write record into it before
    // returning what would otherwise be a normal successful result —
    // mirroring what wrapToolWithSemanticCheck does inside a real tool
    // call, without needing the full tool-call machinery here.
    const flaggingRuntime: AgentHarness = {
      id: 'claude-sdk' as HarnessId,
      async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
        capturedExecuteInputs.push(input);
        input.toolSurface.flaggedWritesAccumulator?.push({
          toolName: 'vault_mark_processed',
          reason: 'batch_id does not appear in this phase\'s declared scope',
        });
        return { finalText: 'looks done', turnsUsed: 1, usage: DEFAULT_USAGE, sessionRef: 'session-1' };
      },
      supports: () => false,
    };
    getAgentHarnessOverride = flaggingRuntime;

    const ctx = baseContext({
      config: baseConfig([phase('only-phase')], { semanticWriteCheckEnabled: true }),
    });

    const result = await executePhasedQuery(ctx);

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].status).toBe('failed');
    expect(result.phases[0].summary).toContain('vault_mark_processed');
    expect(result.phases[0].summary).toContain('Semantic check blocked');
  });
});
