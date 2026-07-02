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

// Captures the options object runMapPhaseAdapter passes to createVaultTools
// (mirrors map-phase-hooks.test.ts's mocking pattern) so the map-phase
// phasePurpose construction site (phase-loop.ts's runMapPhaseAdapter) can be
// asserted without needing full map-item harness scaffolding.
const createVaultToolsCalls: unknown[] = [];
mock.module('@myco/agent/tools.js', () => ({
  createVaultTools: (...args: unknown[]) => {
    createVaultToolsCalls.push(args);
    return [];
  },
}));

let executeMapPhaseResult: unknown = {
  itemCount: 0, written: 0, skipped: 0, failed: 0, abandoned: 0,
  skipReasons: {}, writeAfterThrow: 0, providerUnavailable: false, unavailable: 0,
  usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0, durationMs: 0 },
};
mock.module('@myco/agent/map-phase.js', () => ({
  executeMapPhase: async () => executeMapPhaseResult,
}));

import { executePhasedQuery, executePhase, type PhaseLoopContext } from '@myco/agent/phase-loop.js';

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
  createVaultToolsCalls.length = 0;
  executeMapPhaseResult = {
    itemCount: 0, written: 0, skipped: 0, failed: 0, abandoned: 0,
    skipReasons: {}, writeAfterThrow: 0, providerUnavailable: false, unavailable: 0,
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0, durationMs: 0 },
  };
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

  it('never leaks the classifier\'s verbatim reason into PhaseResult.summary — Fix 6a regression', async () => {
    // Fix 6(a): PhaseResult.summary flows into LATER phases' prompts via
    // prompt-composition.ts's priorPhaseResults splice (failed phases are
    // included, not just completed ones). Embedding verdict.reason here
    // would re-introduce the exact oracle signal the scrubbed tool-error
    // message (recordFlagAndThrow, tools.ts) was built to prevent — just
    // one layer up, in the summary instead of the direct error.
    const secretReason = 'batch_id 999999 targets a different project than this phase is scoped to';
    const flaggingRuntime: AgentHarness = {
      id: 'claude-sdk' as HarnessId,
      async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
        capturedExecuteInputs.push(input);
        input.toolSurface.flaggedWritesAccumulator?.push({
          toolName: 'vault_mark_processed',
          reason: secretReason,
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

    expect(result.phases[0].status).toBe('failed');
    expect(result.phases[0].summary).not.toContain(secretReason);
    // Generic message + tool name are still present.
    expect(result.phases[0].summary).toContain('vault_mark_processed');
    expect(result.phases[0].summary).toContain('Semantic check blocked');
  });

  it('does not reuse the blocked phase\'s session on resume — Fix 1 regression', async () => {
    // Critical regression: a semantic-check-blocked phase (converted to
    // "failed" by snapshotFlaggedWrites, but with turnsUsed > 0) must NOT
    // have its session reused on resume. Reusing it would hand the model
    // its own blocked tool call in conversation history, letting it retry
    // that call against a fresh accumulator + fresh verdict cache — quietly
    // defeating the semantic check the run originally enforced.
    const flaggingRuntime: AgentHarness = {
      id: 'claude-sdk' as HarnessId,
      async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
        capturedExecuteInputs.push(input);
        input.toolSurface.flaggedWritesAccumulator?.push({
          toolName: 'vault_mark_processed',
          reason: 'batch_id does not appear in this phase\'s declared scope',
        });
        return { finalText: 'looks done', turnsUsed: 3, usage: DEFAULT_USAGE, sessionRef: 'blocked-session' };
      },
      supports: () => false,
    };
    getAgentHarnessOverride = flaggingRuntime;

    const checkpointState = baseCheckpoint();
    const ctx = baseContext({
      config: baseConfig([phase('only-phase')], { semanticWriteCheckEnabled: true }),
      checkpointState,
    });

    const dispatchResult = await executePhasedQuery(ctx);
    expect(dispatchResult.phases[0].status).toBe('failed');
    expect(dispatchResult.phases[0].semanticCheckBlocked).toBe(true);

    // The checkpoint written by the dispatch attempt carries the marker and
    // the blocked session's ref, and (unlike the zero-turns exclusion) has
    // turnsUsed > 0 — so only the new semanticCheckBlocked exclusion can
    // prevent reuse here.
    const persistedCheckpoint = checkpointState.phases['only-phase'];
    expect(persistedCheckpoint.semanticCheckBlocked).toBe(true);
    expect(persistedCheckpoint.turnsUsed).toBeGreaterThan(0);
    expect(persistedCheckpoint.sessionRef).toBe('blocked-session');

    // Simulate a resume: same checkpointState (as a fresh run would restore
    // from the persisted run row), fresh capturedExecuteInputs.
    capturedExecuteInputs = [];
    const resumeCtx = baseContext({
      config: baseConfig([phase('only-phase')], { semanticWriteCheckEnabled: true }),
      checkpointState,
    });
    await executePhasedQuery(resumeCtx);

    expect(capturedExecuteInputs).toHaveLength(1);
    expect(capturedExecuteInputs[0].sessionRef).toBeDefined();
    expect(capturedExecuteInputs[0].sessionRef).not.toBe('blocked-session');
  });

  it('uses an authored phase.purpose verbatim as toolSurface.phasePurpose.promptExcerpt, not the prompt excerpt', async () => {
    const longPrompt = 'x'.repeat(600); // longer than the 500-char excerpt cap, to prove it is bypassed entirely
    const authoredPurpose = 'Mark stale prompt batches as processed. Never touch batches outside this run.';
    const ctx = baseContext({
      config: baseConfig([phase('only-phase', { prompt: longPrompt, purpose: authoredPurpose })], {
        semanticWriteCheckEnabled: true,
      }),
    });

    await executePhasedQuery(ctx);

    expect(capturedExecuteInputs.length).toBeGreaterThan(0);
    const surface = capturedExecuteInputs[0].toolSurface as {
      phasePurpose?: { name?: string; promptExcerpt?: string };
    };
    expect(surface.phasePurpose?.promptExcerpt).toBe(authoredPurpose);
    expect(surface.phasePurpose?.promptExcerpt).not.toContain('x'.repeat(500));
  });

  it('falls back to the truncated prompt excerpt on toolSurface.phasePurpose when phase.purpose is absent', async () => {
    const longPrompt = 'y'.repeat(600);
    const ctx = baseContext({
      config: baseConfig([phase('only-phase', { prompt: longPrompt })], {
        semanticWriteCheckEnabled: true,
      }),
    });

    await executePhasedQuery(ctx);

    expect(capturedExecuteInputs.length).toBeGreaterThan(0);
    const surface = capturedExecuteInputs[0].toolSurface as {
      phasePurpose?: { name?: string; promptExcerpt?: string };
    };
    expect(surface.phasePurpose?.promptExcerpt).toBe(`${'y'.repeat(500)}…`);
  });
});

describe('phase-loop semantic-check phasePurpose threading — map-phase path', () => {
  it('uses an authored phase.purpose verbatim as the phasePurpose passed to createVaultTools for a map phase', async () => {
    // Mirrors map-phase-hooks.test.ts's Fix 5 regression test: the map path
    // builds phasePurpose independently of the regular (wave-input) path,
    // inside runMapPhaseAdapter's own createVaultTools call.
    const authoredPurpose = 'Describe each source file in one sentence. Never write outside canopy_entries.';
    const longPrompt = 'z'.repeat(600);

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
    } as PhaseLoopContext;

    const mapPhase: PhaseDefinition = {
      name: 'map-describe',
      prompt: longPrompt,
      purpose: authoredPurpose,
      tools: [],
      maxTurns: 5,
      required: true,
      mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'sink_tool', argMap: {} },
    } as PhaseDefinition;

    await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase: mapPhase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(createVaultToolsCalls).toHaveLength(1);
    const [, , options] = createVaultToolsCalls[0] as [string, string, {
      phasePurpose?: { name?: string; promptExcerpt?: string };
    }];
    expect(options.phasePurpose?.name).toBe('map-describe');
    expect(options.phasePurpose?.promptExcerpt).toBe(authoredPurpose);
    expect(options.phasePurpose?.promptExcerpt).not.toContain('z'.repeat(500));
  });

  it('falls back to the truncated prompt excerpt for a map phase when phase.purpose is absent', async () => {
    const longPrompt = 'w'.repeat(600);

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
    } as PhaseLoopContext;

    const mapPhase: PhaseDefinition = {
      name: 'map-describe',
      prompt: longPrompt,
      tools: [],
      maxTurns: 5,
      required: true,
      mode: 'map',
      source: { tool: 'source_tool', args: {}, itemsPath: 'items' },
      item: { prompt: 'do {{item.path}}' },
      sink: { tool: 'sink_tool', argMap: {} },
    } as PhaseDefinition;

    await executePhase({
      ctx, phasePrompt: '', phaseModel: 'claude-sonnet-4-6', phase: mapPhase,
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
    });

    expect(createVaultToolsCalls).toHaveLength(1);
    const [, , options] = createVaultToolsCalls[0] as [string, string, {
      phasePurpose?: { name?: string; promptExcerpt?: string };
    }];
    expect(options.phasePurpose?.name).toBe('map-describe');
    expect(options.phasePurpose?.promptExcerpt).toBe(`${'w'.repeat(500)}…`);
  });
});
