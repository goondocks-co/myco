/**
 * Regression tests 2, 3, and 5 for the resume-admission gate.
 *
 * Mirrors phase-loop.test.ts's mock harness (checkPhasePostCondition mocked
 * at module level, executePhasedQuery called directly against a
 * hand-constructed PhaseLoopContext) so these can assert on the checkpoint
 * re-validation seam without a full runAgent DB round trip.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type {
  EffectiveConfig,
  PhaseDefinition,
  RuntimeUsage,
  HarnessId,
} from '@myco/agent/types.js';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import type { RunCheckpointState, PhaseCheckpoint } from '@myco/agent/executor-state.js';

// ---------------------------------------------------------------------------
// Harness mock — records every execute() call so tests can assert on WHICH
// phases actually re-ran (vs. stayed restored).
// ---------------------------------------------------------------------------

let capturedExecuteInputs: HarnessExecuteInput[] = [];
let executeResultOverride: Partial<HarnessExecuteResult> | null = null;

const DEFAULT_USAGE: RuntimeUsage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 200,
  totalTokens: 300,
  reasoningTokens: 0,
  cachedTokens: 0,
  durationMs: 10,
};

const fakeRuntime: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    capturedExecuteInputs.push(input);
    return {
      finalText: 'ok',
      turnsUsed: 1,
      usage: DEFAULT_USAGE,
      sessionRef: 'fresh-session-' + capturedExecuteInputs.length,
      ...executeResultOverride,
    };
  },
  supports: () => false,
  classifyError: () => 'unknown',
};

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => fakeRuntime,
}));

mock.module('@myco/agent/phase-preconditions.js', () => ({
  checkPhasePreCondition: () => ({ passed: true, reason: 'default-pass' }),
}));

// Programmable per test — the seam under test. Each call is recorded so
// tests can assert re-validation actually ran (and with what projectId/
// dryRun) without duplicating the live phase-postconditions.ts logic.
// `checkPostConditionImpl` is reassigned per test (never mock.module again)
// so behavior swaps never leak across tests the way re-calling mock.module
// mid-test would.
type PostConditionResult = { passed: boolean; reason: string };
let postConditionResultsByKind: Record<string, PostConditionResult> = {};
let postConditionCalls: Array<{ kind: string; input: Record<string, unknown> }> = [];
let checkPostConditionImpl = (kind: string, _input: Record<string, unknown>): PostConditionResult =>
  postConditionResultsByKind[kind] ?? { passed: true, reason: 'ok' };

mock.module('@myco/agent/phase-postconditions.js', () => ({
  checkPhasePostCondition: (kind: string, input: Record<string, unknown>) => {
    postConditionCalls.push({ kind, input });
    return checkPostConditionImpl(kind, input);
  },
}));

mock.module('@myco/grove/request-context.js', () => ({
  projectScopeFromRequestContext: () => ({ kind: 'all' as const }),
  rowProjectIdFromRequestContext: () => 'proj_test',
}));

mock.module('@myco/agent/cost/index.js', () => ({
  resolveCost: async () => ({
    source: 'actual' as const,
    costUsd: 0.01,
    actualCostUsd: 0.01,
    estimatedCostUsd: 0,
    breakdown: {
      inputTokens: 100,
      cachedInputTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 0,
      requestCount: 1,
      totalCostUsd: 0.01,
    },
  }),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mock.module() so the mocks apply.
// ---------------------------------------------------------------------------

import { executePhasedQuery, type PhaseLoopContext } from '@myco/agent/phase-loop.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function baseConfig(phases: PhaseDefinition[]): EffectiveConfig {
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
    phases,
  } as EffectiveConfig;
}

function phase(name: string, extra: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    name,
    prompt: `prompt for ${name}`,
    tools: [],
    maxTurns: 3,
    required: false,
    ...extra,
  } as PhaseDefinition;
}

function restoredCheckpoint(name: string, extra: Partial<PhaseCheckpoint> = {}): PhaseCheckpoint {
  return {
    name,
    status: 'completed',
    summary: `${name} summary from prior attempt`,
    turnsUsed: 2,
    tokensUsed: 150,
    sessionRef: `restored-session-${name}`,
    updatedAt: 0,
    ...extra,
  };
}

function baseContext(overrides: Partial<PhaseLoopContext> = {}): PhaseLoopContext {
  return {
    config: baseConfig([]),
    systemPrompt: 'SYSTEM',
    vaultContext: 'VAULT CONTEXT',
    agentId: 'myco-agent',
    runId: 'run-resume-admission',
    instruction: undefined,
    abortController: new AbortController(),
    projectRoot: '/tmp/resume-admission-test',
    vaultDir: '/tmp/resume-admission-test/.myco',
    options: undefined,
    checkpointState: { harness: 'claude-sdk', phases: {} } as RunCheckpointState,
    requestContext: { projectId: 'proj_test' } as unknown as PhaseLoopContext['requestContext'],
    ...overrides,
  };
}

beforeEach(() => {
  capturedExecuteInputs = [];
  executeResultOverride = null;
  postConditionResultsByKind = {};
  postConditionCalls = [];
  checkPostConditionImpl = (kind) => postConditionResultsByKind[kind] ?? { passed: true, reason: 'ok' };
});

// ---------------------------------------------------------------------------
// Regression test 2: restored completed phase with an unsatisfied
// postCondition must be BOTH demoted in the checkpoint AND omitted from
// restored results, then re-executed with a FRESH session.
// ---------------------------------------------------------------------------

describe('checkpoint re-validation at the phase-loop restore seam (Part 2)', () => {
  it('(a) mutates the checkpoint state entry to failed + postConditionFailed as soon as re-validation fails', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory', { sessionRef: 'poisoned-restored-session' }),
      },
    };
    // Fail BOTH the re-validation call and the fresh execution's own
    // phase-boundary gate — isolates assertion (a) (the state mutation)
    // from re-execution's own bookkeeping, since the final checkpoint
    // write always reflects the LATEST attempt's outcome.
    postConditionResultsByKind['skill-evolve-inventory'] = { passed: false, reason: 'inventory report missing' };

    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    await executePhasedQuery(ctx);

    // The checkpoint's FINAL state (after demotion AND re-execution, which
    // also failed its own gate) is 'failed' + postConditionFailed:true —
    // proving the demotion write took effect and re-execution actually ran
    // (a phase that stayed trusted/restored would never re-invoke the gate
    // a second time here).
    expect(checkpointState.phases.inventory.status).toBe('failed');
    expect(checkpointState.phases.inventory.postConditionFailed).toBe(true);
    expect(capturedExecuteInputs).toHaveLength(1);
  });

  it('(b) omits the demoted phase from restored results and re-executes it with a FRESH session (never the poisoned restored one)', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory', { sessionRef: 'poisoned-restored-session' }),
      },
    };
    // Fails the RE-VALIDATION check (first call, against the restored
    // checkpoint) but passes the live phase-boundary gate's check after
    // the phase re-executes (second call) — models "the artifact the
    // restored checkpoint pointed at is gone, but the fresh execution
    // produces a new one that satisfies the contract."
    let postConditionCallCount = 0;
    checkPostConditionImpl = () => {
      postConditionCallCount += 1;
      return postConditionCallCount === 1
        ? { passed: false, reason: 'inventory report missing on re-check' }
        : { passed: true, reason: 'ok' };
    };

    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    // The phase was RE-EXECUTED this attempt (not left restored) — proven
    // by an actual harness call, and by the final result showing a
    // completed status with a FRESH sessionRef (never the poisoned restored one).
    // This is only possible because (b) omitted it from phaseResults, so
    // the runnableWave filter re-included it instead of skipping it as
    // already-completed.
    expect(capturedExecuteInputs).toHaveLength(1);
    expect(result.executedPhaseCount).toBe(1);
    const finalPhase = result.phases.find((p) => p.name === 'inventory')!;
    expect(finalPhase.status).toBe('completed');
    expect(finalPhase.sessionRef).not.toBe('poisoned-restored-session');
    expect(finalPhase.sessionRef).toMatch(/^fresh-session-/);
  });

  it('never re-validates a restored SKIPPED phase, even when it declares a postCondition', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory', { status: 'skipped' }),
      },
    };
    // If re-validation ran against a skipped phase, this would fail it —
    // proving the loop must never call checkPhasePostCondition for 'skipped'.
    postConditionResultsByKind['skill-evolve-inventory'] = { passed: false, reason: 'would fail if checked' };

    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    expect(postConditionCalls).toHaveLength(0);
    expect(checkpointState.phases.inventory.status).toBe('skipped');
    expect(capturedExecuteInputs).toHaveLength(0);
    expect(result.phases.find((p) => p.name === 'inventory')?.status).toBe('skipped');
  });

  it('keeps a restored completed phase trusted when its postCondition still passes on re-check', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory'),
      },
    };
    postConditionResultsByKind['skill-evolve-inventory'] = { passed: true, reason: 'ok' };

    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    expect(postConditionCalls).toHaveLength(1);
    expect(capturedExecuteInputs).toHaveLength(0);
    expect(result.executedPhaseCount).toBe(0);
    expect(checkpointState.phases.inventory.status).toBe('completed');
    expect(result.phases.find((p) => p.name === 'inventory')?.status).toBe('completed');
  });

  it('fails open (keeps the restored result) when the re-validation check throws', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory'),
      },
    };
    checkPostConditionImpl = () => {
      throw new Error('transient SQL error');
    };

    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    expect(capturedExecuteInputs).toHaveLength(0);
    expect(checkpointState.phases.inventory.status).toBe('completed');
    expect(checkpointState.phases.inventory.postConditionFailed).toBeUndefined();
    expect(result.phases.find((p) => p.name === 'inventory')?.status).toBe('completed');
  });

  it('bypasses re-validation loudly when no requestContext is available (contract unverified until run end)', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory'),
      },
    };
    postConditionResultsByKind['skill-evolve-inventory'] = { passed: false, reason: 'would fail if checked' };

    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState, requestContext: undefined });

    const result = await executePhasedQuery(ctx);

    expect(postConditionCalls).toHaveLength(0);
    expect(capturedExecuteInputs).toHaveLength(0);
    expect(checkpointState.phases.inventory.status).toBe('completed');
    expect(result.phases.find((p) => p.name === 'inventory')?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Regression test 3: an all-restored resume whose run-end validator still
// fails must be distinguishable via executedPhaseCount === 0. Tested at the
// phase-loop level here (the typed-error / terminal-mark half lives in
// executor-postcondition-unsatisfiable.test.ts, which exercises the full
// runAgent path).
// ---------------------------------------------------------------------------

describe('executedPhaseCount signal (Part 3 foundation)', () => {
  it('is zero when every phase in the plan was restored (none re-executed)', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        a: restoredCheckpoint('a'),
        b: restoredCheckpoint('b'),
      },
    };
    const phases = [phase('a'), phase('b')];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    expect(result.executedPhaseCount).toBe(0);
    expect(capturedExecuteInputs).toHaveLength(0);
  });

  it('is greater than zero when at least one phase actually re-executes', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        a: restoredCheckpoint('a'),
      },
    };
    // 'b' has no checkpoint entry — it's fresh work this attempt.
    const phases = [phase('a'), phase('b')];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    expect(result.executedPhaseCount).toBe(1);
    expect(capturedExecuteInputs).toHaveLength(1);
  });

  it('counts a Part-2-demoted phase as executed', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        inventory: restoredCheckpoint('inventory'),
      },
    };
    postConditionResultsByKind['skill-evolve-inventory'] = { passed: false, reason: 'stale' };
    const phases = [phase('inventory', { postCondition: 'skill-evolve-inventory' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    const result = await executePhasedQuery(ctx);

    expect(result.executedPhaseCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression test 5: contract pin on the restore path — re-validation
// failure produces the SAME postConditionFailed flag + fresh-session
// exclusion the live (fresh-path) gate already produces. Proven here by
// checking the demoted phase reuses the reuseSession exclusion (fresh
// sessionRef, never the restored one) exactly like phase-loop.test.ts's
// existing fresh-path assertions for semanticCheckBlocked/postConditionFailed.
// ---------------------------------------------------------------------------

describe('contract pin: restore-path demotion matches fresh-path postConditionFailed shape (Part 5)', () => {
  it('sets postConditionFailed on the checkpoint and forces a fresh session — identical shape to the live gate', async () => {
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        assess: restoredCheckpoint('assess', { sessionRef: 'stale-session-to-exclude', turnsUsed: 5 }),
      },
    };
    postConditionResultsByKind['skill-evolve-assess'] = { passed: false, reason: 'classification payload stale' };
    const phases = [phase('assess', { postCondition: 'skill-evolve-assess' })];
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });

    await executePhasedQuery(ctx);

    // Same marker name/shape the live phase-boundary gate sets on a fresh
    // failure (phase-loop.ts's postCondition block) — a resumed run must
    // read this identically regardless of which seam set it.
    expect(checkpointState.phases.assess.postConditionFailed).toBe(true);
    expect(checkpointState.phases.assess.status).toBe('failed');

    // reuseSession exclusion: postConditionFailed !== true is required to
    // reuse a session — since it IS true here, a fresh session must have
    // been minted, never the stale restored one.
    expect(capturedExecuteInputs).toHaveLength(1);
    expect(capturedExecuteInputs[0].sessionRef).not.toBe('stale-session-to-exclude');
  });
});
