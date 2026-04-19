/**
 * Unit tests for the extracted phase-loop functions.
 *
 * These tests call executePhase / executeSingleQuery / executePhasedQuery
 * directly with a hand-constructed PhaseLoopContext, bypassing runAgent's
 * DB bookkeeping. The runtime adapter is mocked so dispatch goes through
 * a programmable fake instead of a real SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  EffectiveConfig,
  PhaseDefinition,
  RuntimeUsage,
  RuntimeId,
} from '@myco/agent/types.js';
import type { AgentRuntime, RuntimeExecuteInput, RuntimeExecuteResult } from '@myco/agent/runtime/types.js';
import type { RunCheckpointState } from '@myco/agent/executor-state.js';

// ---------------------------------------------------------------------------
// Runtime mock — controls execute() behavior per test.
// ---------------------------------------------------------------------------

type RuntimeBehavior =
  | { kind: 'success'; result?: Partial<RuntimeExecuteResult> }
  | { kind: 'error'; message?: string }
  | { kind: 'abort' };

let runtimeBehaviors: RuntimeBehavior[] = [];
let defaultRuntimeBehavior: RuntimeBehavior = { kind: 'success' };
let capturedExecuteInputs: RuntimeExecuteInput[] = [];
let runtimeSupportsSessionResume = false;

const DEFAULT_USAGE: RuntimeUsage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 200,
  totalTokens: 300,
  reasoningTokens: 0,
  cachedTokens: 0,
  durationMs: 10,
};

function nextBehavior(): RuntimeBehavior {
  return runtimeBehaviors.length > 0 ? runtimeBehaviors.shift()! : defaultRuntimeBehavior;
}

const fakeRuntime: AgentRuntime = {
  id: 'claude-sdk' as RuntimeId,
  async execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteResult> {
    capturedExecuteInputs.push(input);
    const behavior = nextBehavior();
    if (behavior.kind === 'error') {
      throw new Error(behavior.message ?? 'runtime error');
    }
    if (behavior.kind === 'abort') {
      const c = input.abortController;
      if (c instanceof AbortController) {
        c.abort(new Error('aborted by test'));
      }
      throw new Error('runtime aborted');
    }
    return {
      finalText: 'ok',
      turnsUsed: 1,
      usage: DEFAULT_USAGE,
      sessionRef: 'session-' + (capturedExecuteInputs.length),
      ...behavior.result,
    };
  },
  supports(capability) {
    if (capability === 'supportsSessionResume') return runtimeSupportsSessionResume;
    return false;
  },
};

vi.mock('@myco/agent/runtime/index.js', () => ({
  getAgentRuntime: () => fakeRuntime,
}));

// Cost resolution is async but doesn't need real numbers here.
vi.mock('@myco/agent/cost/index.js', () => ({
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
// Imports AFTER vi.mock() so the mocks apply.
// ---------------------------------------------------------------------------

import {
  executePhase,
  executeSingleQuery,
  executePhasedQuery,
  type PhaseLoopContext,
} from '@myco/agent/phase-loop.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function baseConfig(phases?: PhaseDefinition[]): EffectiveConfig {
  return {
    taskName: 'test-task',
    taskDisplayName: 'Test Task',
    taskPrompt: 'Do the thing.',
    systemPromptPath: 'prompts/system.md',
    runtime: 'claude-sdk',
    model: 'claude-sonnet-4',
    maxTurns: 5,
    timeoutSeconds: 60,
    tools: [],
    ...(phases ? { phases } : {}),
  } as EffectiveConfig;
}

function baseCheckpoint(): RunCheckpointState {
  return {
    runtime: 'claude-sdk',
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
    abortController: new AbortController(),
    projectRoot: '/tmp/project',
    vaultDir: '/tmp/project/.myco',
    options: undefined,
    checkpointState: baseCheckpoint(),
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// Reset per test
// ---------------------------------------------------------------------------

beforeEach(() => {
  runtimeBehaviors = [];
  defaultRuntimeBehavior = { kind: 'success' };
  capturedExecuteInputs = [];
  runtimeSupportsSessionResume = false;
});

// ---------------------------------------------------------------------------
// executePhase — happy path, error, abort
// ---------------------------------------------------------------------------

describe('executePhase', () => {
  it('returns a completed PhaseResult on runtime success', async () => {
    const ctx = baseContext();
    const p = phase('draft');
    const result = await executePhase(
      ctx,
      'PROMPT',
      'claude-sonnet-4',
      p,
      {
        agentId: ctx.agentId,
        runId: ctx.runId,
        toolNames: [],
        turnOffset: 0,
      },
    );
    expect(result.status).toBe('completed');
    expect(result.name).toBe('draft');
    expect(result.turnsUsed).toBe(1);
    expect(capturedExecuteInputs).toHaveLength(1);
    expect(capturedExecuteInputs[0].systemPrompt).toBe('SYSTEM');
  });

  it('returns a failed PhaseResult when runtime throws', async () => {
    defaultRuntimeBehavior = { kind: 'error', message: 'boom' };
    const ctx = baseContext();
    const result = await executePhase(
      ctx,
      'PROMPT',
      'claude-sonnet-4',
      phase('draft'),
      { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    );
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('boom');
  });

  it('reports abort reason when the run is aborted mid-execution', async () => {
    defaultRuntimeBehavior = { kind: 'abort' };
    const ctx = baseContext();
    const result = await executePhase(
      ctx,
      'PROMPT',
      'claude-sonnet-4',
      phase('draft'),
      { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    );
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('aborted');
    expect(ctx.abortController!.signal.aborted).toBe(true);
  });

  it('retries without sessionRef when session resume fails on a supporting runtime', async () => {
    runtimeSupportsSessionResume = true;
    runtimeBehaviors = [{ kind: 'error', message: 'unable to resume session' }];
    // Default success for the retry
    const ctx = baseContext();
    const result = await executePhase(
      ctx,
      'PROMPT',
      'claude-sonnet-4',
      phase('draft'),
      { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
      undefined,
      'prior-session',
    );
    expect(result.status).toBe('completed');
    // Two execute calls: first with sessionRef, retry without.
    expect(capturedExecuteInputs).toHaveLength(2);
    expect(capturedExecuteInputs[0].sessionRef).toBe('prior-session');
    expect(capturedExecuteInputs[1].sessionRef).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeSingleQuery — happy path
// ---------------------------------------------------------------------------

describe('executeSingleQuery', () => {
  it('returns tokensUsed + cost on success', async () => {
    const ctx = baseContext();
    const result = await executeSingleQuery(ctx, 'PROMPT');
    expect(result.tokensUsed).toBe(300);
    expect(result.costUsd).toBe(0.01);
    expect(result.usage.totalTokens).toBe(300);
    expect(capturedExecuteInputs).toHaveLength(1);
  });

  it('forwards sessionRef/sessionData into the runtime call', async () => {
    const ctx = baseContext();
    await executeSingleQuery(ctx, 'PROMPT', undefined, 'prev-session', { key: 1 });
    expect(capturedExecuteInputs[0].sessionRef).toBe('prev-session');
    expect(capturedExecuteInputs[0].sessionData).toEqual({ key: 1 });
  });

  it('propagates errors by throwing', async () => {
    defaultRuntimeBehavior = { kind: 'error', message: 'sdk_fail' };
    const ctx = baseContext();
    await expect(executeSingleQuery(ctx, 'PROMPT')).rejects.toThrow(/sdk_fail/);
  });
});

// ---------------------------------------------------------------------------
// executePhasedQuery — waves, checkpoint mutation, required-phase stop.
// ---------------------------------------------------------------------------

describe('executePhasedQuery', () => {
  it('runs phases in order and aggregates usage/cost', async () => {
    const phases = [phase('a'), phase('b')];
    const ctx = baseContext({ config: baseConfig(phases) });
    const result = await executePhasedQuery(ctx);
    expect(result.phases).toHaveLength(2);
    expect(result.phases.map((p) => p.name)).toEqual(['a', 'b']);
    expect(result.phases.every((p) => p.status === 'completed')).toBe(true);
    // 2 phases × DEFAULT_USAGE.totalTokens(300) = 600
    expect(result.tokensUsed).toBe(600);
  });

  it('mutates checkpointState on the context so finalization can read it back', async () => {
    const phases = [phase('a'), phase('b')];
    const checkpointState = baseCheckpoint();
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(Object.keys(checkpointState.phases).sort()).toEqual(['a', 'b']);
    expect(checkpointState.phases.a.status).toBe('completed');
    expect(checkpointState.phases.b.status).toBe('completed');
  });

  it('invokes persistCheckpoints between waves', async () => {
    const phases = [phase('a'), phase('b')];
    const persistCheckpoints = vi.fn().mockResolvedValue(undefined);
    const ctx = baseContext({
      config: baseConfig(phases),
      persistCheckpoints,
    });
    await executePhasedQuery(ctx);
    expect(persistCheckpoints).toHaveBeenCalled();
  });

  it('stops the pipeline when a required phase fails in an earlier wave', async () => {
    // Two waves: 'a' (required, wave 0) → 'b' (dependsOn a, wave 1).
    // 'a' fails; 'b' must not run.
    const phases = [
      phase('a', { required: true }),
      phase('b', { dependsOn: ['a'] } as Partial<PhaseDefinition>),
    ];
    runtimeBehaviors = [{ kind: 'error', message: 'required phase crashed' }];
    defaultRuntimeBehavior = { kind: 'success' };
    const ctx = baseContext({ config: baseConfig(phases) });
    const result = await executePhasedQuery(ctx);
    expect(result.phases.find((p) => p.name === 'a')?.status).toBe('failed');
    expect(result.phases.find((p) => p.name === 'b')).toBeUndefined();
  });

  it('records failed phases when the abort signal fires mid-execution', async () => {
    const phases = [phase('a')];
    defaultRuntimeBehavior = { kind: 'abort' };
    const ctx = baseContext({ config: baseConfig(phases) });
    const result = await executePhasedQuery(ctx);
    expect(result.phases[0].status).toBe('failed');
    expect(ctx.abortController!.signal.aborted).toBe(true);
  });

  it('does not reuse sessionRef when prior attempt failed with zero turns', async () => {
    const phases = [phase('a')];
    const checkpointState: RunCheckpointState = {
      runtime: 'claude-sdk',
      phases: {
        a: {
          name: 'a',
          status: 'failed',
          turnsUsed: 0,
          sessionRef: 'poisoned-session',
          updatedAt: 0,
        },
      },
    };
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(capturedExecuteInputs[0].sessionRef).toBeDefined();
    expect(capturedExecuteInputs[0].sessionRef).not.toBe('poisoned-session');
  });

  it('reuses sessionRef when prior attempt failed after producing turns', async () => {
    const phases = [phase('a')];
    const checkpointState: RunCheckpointState = {
      runtime: 'claude-sdk',
      phases: {
        a: {
          name: 'a',
          status: 'failed',
          turnsUsed: 4,
          sessionRef: 'recoverable-session',
          updatedAt: 0,
        },
      },
    };
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(capturedExecuteInputs[0].sessionRef).toBe('recoverable-session');
  });
});
