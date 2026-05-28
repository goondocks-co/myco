/**
 * Unit tests for the extracted phase-loop functions.
 *
 * These tests call executePhase / executeSingleQuery / executePhasedQuery
 * directly with a hand-constructed PhaseLoopContext, bypassing runAgent's
 * DB bookkeeping. The harness adapter is mocked so dispatch goes through
 * a programmable fake instead of a real SDK.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import type {
  EffectiveConfig,
  PhaseDefinition,
  RuntimeUsage,
  HarnessId,
} from '@myco/agent/types.js';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import type { RunCheckpointState } from '@myco/agent/executor-state.js';

// ---------------------------------------------------------------------------
// Harness mock — controls execute() behavior per test.
// ---------------------------------------------------------------------------

type RuntimeBehavior =
  | { kind: 'success'; result?: Partial<HarnessExecuteResult> }
  | { kind: 'error'; message?: string }
  | { kind: 'abort' };

let runtimeBehaviors: RuntimeBehavior[] = [];
let defaultRuntimeBehavior: RuntimeBehavior = { kind: 'success' };
let capturedExecuteInputs: HarnessExecuteInput[] = [];
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

/**
 * Mirror the real claude.ts adapter's throw shape so capHit classification
 * tests exercise the real code path. The adapter wraps errors that happened
 * after some usage was recorded as HarnessExecutionError with a `kind`
 * field; phase-loop reads `kind === 'max-turns'` to set capHit.
 */
function throwLikeAdapter(message: string): never {
  const kind: 'max-turns' | 'other' = /reached.*maximum number of turns|max\s*turns/i.test(message)
    ? 'max-turns'
    : 'other';
  throw new HarnessExecutionError(
    message,
    { usage: DEFAULT_USAGE, kind },
  );
}

const fakeRuntime: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    capturedExecuteInputs.push(input);
    const behavior = nextBehavior();
    if (behavior.kind === 'error') {
      throwLikeAdapter(behavior.message ?? 'runtime error');
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
	  classifyError(error) {
	    const message = error instanceof Error ? error.message : String(error);
	    if (/exited with code/i.test(message)) return 'session-expired';
	    if (/unable to resume session/i.test(message)) return 'session-resume-failed';
	    return 'unknown';
	  },
};

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => fakeRuntime,
}));

// Per-phase preCondition resolver — programmable per test.
let phasePreConditionResult: { passed: boolean; reason: string } = { passed: true, reason: 'default-pass' };
mock.module('@myco/agent/phase-preconditions.js', () => ({
  checkPhasePreCondition: () => phasePreConditionResult,
}));

// projectScopeFromRequestContext is called only when a requestContext is
// present; tests that supply one need a non-throwing stub.
mock.module('@myco/tools/request-context.js', () => ({
  projectScopeFromRequestContext: () => ({ kind: 'all' as const }),
}));

// Cost resolution is async but doesn't need real numbers here.
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
    harness: 'claude-sdk',
    model: 'claude-sonnet-4',
    maxTurns: 5,
    timeoutSeconds: 60,
    tools: [],
    ...(phases ? { phases } : {}),
  } as EffectiveConfig;
}

function baseCheckpoint(): RunCheckpointState {
  return {
    harness: 'claude-sdk',
    phases: {},
  };
}

let TEST_PROJECT_ROOT: string;
let TEST_VAULT_DIR: string;

function baseContext(overrides: Partial<PhaseLoopContext> = {}): PhaseLoopContext {
  return {
    config: baseConfig(),
    systemPrompt: 'SYSTEM',
    vaultContext: 'VAULT CONTEXT',
    agentId: 'myco-agent',
    runId: 'run-123',
    instruction: undefined,
    abortController: new AbortController(),
    projectRoot: TEST_PROJECT_ROOT,
    vaultDir: TEST_VAULT_DIR,
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
  phasePreConditionResult = { passed: true, reason: 'default-pass' };
});

// ---------------------------------------------------------------------------
// executePhase — happy path, error, abort
// ---------------------------------------------------------------------------

describe('executePhase', () => {
  beforeAll(() => {
    TEST_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-loop-'));
    TEST_VAULT_DIR = path.join(TEST_PROJECT_ROOT, '.myco');
    fs.mkdirSync(TEST_VAULT_DIR, { recursive: true });
    ensureProjectManifest(TEST_VAULT_DIR, { projectName: 'phase-loop' });
  });
  afterAll(() => {
    fs.rmSync(TEST_PROJECT_ROOT, { recursive: true, force: true });
  });

  it('routes mode: map phases to the map-phase path', async () => {
    const mapPhase: PhaseDefinition = {
      name: 'm', prompt: '', tools: [], maxTurns: 1, required: true,
      mode: 'map',
      perItemMaxTurns: 1,
      source: { tool: 'nonexistent', args: {}, itemsPath: 'entries' },
      item: { prompt: 'x' },
      sink: { tool: 'nonexistent', argMap: {} },
    };
    const ctx = baseContext({
      config: {
        ...baseConfig(),
        harness: 'claude-sdk',
      },
    });

    const result = await executePhase({
      ctx,
      phasePrompt: 'p',
      phaseModel: 'm',
      phase: mapPhase,
      toolSurface: { agentId: 'a', runId: 'r' },
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/source tool|nonexistent/i);
  });

  it('returns a completed PhaseResult on runtime success', async () => {
    const ctx = baseContext();
    const p = phase('draft');
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: p,
      toolSurface: {
        agentId: ctx.agentId,
        runId: ctx.runId,
        toolNames: [],
        turnOffset: 0,
      },
    });
    expect(result.status).toBe('completed');
    expect(result.name).toBe('draft');
    expect(result.turnsUsed).toBe(1);
    expect(capturedExecuteInputs).toHaveLength(1);
    expect(capturedExecuteInputs[0].systemPrompt).toBe('SYSTEM');
  });

  it('returns a failed PhaseResult when runtime throws', async () => {
    defaultRuntimeBehavior = { kind: 'error', message: 'boom' };
    const ctx = baseContext();
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('draft'),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('boom');
  });

  it('records capHit + allowedMaxTurns when runtime hits the max-turns budget', async () => {
    // Cost-audit tooling distinguishes budget exhaustion from other failures.
    defaultRuntimeBehavior = {
      kind: 'error',
      message: 'Claude Code returned an error result: Reached maximum number of turns (35)',
    };
    const ctx = baseContext();
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('extract', { maxTurns: 35 }),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('failed');
    expect(result.capHit).toBe(true);
    expect(result.allowedMaxTurns).toBe(35);
    expect(result.summary).toContain('maximum number of turns');
  });

  it('does not set capHit on non-budget failures', async () => {
    defaultRuntimeBehavior = { kind: 'error', message: 'network timeout' };
    const ctx = baseContext();
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('extract', { maxTurns: 35 }),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('failed');
    expect(result.capHit).toBeUndefined();
    // allowedMaxTurns is still recorded on every failure so the audit trail
    // can show the budget the failure was operating against.
    expect(result.allowedMaxTurns).toBe(35);
  });

  it('skips the phase entirely (no harness invocation) when preCondition fails', async () => {
    phasePreConditionResult = { passed: false, reason: 'Only 1 active spores in last 24h (need ≥3)' };
    const ctx = baseContext({
      requestContext: {} as PhaseLoopContext['requestContext'],
    });
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('consolidate-shortlist', { preCondition: 'has-recent-spore-activity' }),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('has-recent-spore-activity');
    expect(result.summary).toContain('Only 1 active spores');
    expect(capturedExecuteInputs).toHaveLength(0);
    expect(result.turnsUsed).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('runs the phase normally when preCondition passes', async () => {
    phasePreConditionResult = { passed: true, reason: 'plenty of spores' };
    const ctx = baseContext({
      requestContext: {} as PhaseLoopContext['requestContext'],
    });
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('consolidate-shortlist', { preCondition: 'has-recent-spore-activity' }),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('completed');
    expect(capturedExecuteInputs).toHaveLength(1);
  });

  it('silently bypasses the preCondition check when no requestContext is available', async () => {
    // requestContext-less paths (some test/embedded callers) should still
    // run — the gate is opt-in, not a hard requirement.
    phasePreConditionResult = { passed: false, reason: 'should not be consulted' };
    const ctx = baseContext({ requestContext: undefined });
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('consolidate-shortlist', { preCondition: 'has-recent-spore-activity' }),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('completed');
    expect(capturedExecuteInputs).toHaveLength(1);
  });

  it('reports abort reason when the run is aborted mid-execution', async () => {
    defaultRuntimeBehavior = { kind: 'abort' };
    const ctx = baseContext();
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('draft'),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
    });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('aborted');
    expect(ctx.abortController!.signal.aborted).toBe(true);
  });

  it('retries without sessionRef when session resume fails on a supporting runtime', async () => {
    runtimeSupportsSessionResume = true;
    runtimeBehaviors = [{ kind: 'error', message: 'unable to resume session' }];
    // Default success for the retry
    const ctx = baseContext();
    const result = await executePhase({
      ctx,
      phasePrompt: 'PROMPT',
      phaseModel: 'claude-sonnet-4',
      phase: phase('draft'),
      toolSurface: { agentId: ctx.agentId, runId: ctx.runId, toolNames: [], turnOffset: 0 },
      sessionId: 'prior-session',
    });
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

  it('retries without sessionRef when the prior session exit-codes out', async () => {
    // Regression for issue #118 item 1: single-query tasks (title-summary,
    // review-session) had no retry — an expired Claude SDK session meant
    // the run looped in the scheduler forever. `isExpiredSessionError`
    // now matches "exited with code" and the retry path triggers.
    runtimeSupportsSessionResume = true;
    runtimeBehaviors = [{ kind: 'error', message: 'Claude Code process exited with code 1' }];
    const ctx = baseContext();
    const result = await executeSingleQuery(ctx, 'PROMPT', undefined, 'stale-session');
    expect(result.tokensUsed).toBe(300);
    expect(capturedExecuteInputs).toHaveLength(2);
    expect(capturedExecuteInputs[0].sessionRef).toBe('stale-session');
    expect(capturedExecuteInputs[1].sessionRef).toBeUndefined();
  });

  it('does not retry when no sessionRef was supplied', async () => {
    runtimeSupportsSessionResume = true;
    runtimeBehaviors = [{ kind: 'error', message: 'Claude Code process exited with code 1' }];
    const ctx = baseContext();
    await expect(executeSingleQuery(ctx, 'PROMPT')).rejects.toThrow(/exited with code/);
    expect(capturedExecuteInputs).toHaveLength(1);
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

  it('persists capHit + allowedMaxTurns onto the checkpoint when SDK hits max-turns', async () => {
    const phases = [phase('a', { maxTurns: 35 })];
    defaultRuntimeBehavior = {
      kind: 'error',
      message: 'Claude Code returned an error result: Reached maximum number of turns (35)',
    };
    const checkpointState = baseCheckpoint();
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(checkpointState.phases.a.status).toBe('failed');
    expect(checkpointState.phases.a.capHit).toBe(true);
    expect(checkpointState.phases.a.allowedMaxTurns).toBe(35);
  });

  it('does not set capHit on the checkpoint for non-budget failures', async () => {
    const phases = [phase('a', { maxTurns: 35 })];
    defaultRuntimeBehavior = { kind: 'error', message: 'network timeout' };
    const checkpointState = baseCheckpoint();
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(checkpointState.phases.a.status).toBe('failed');
    expect(checkpointState.phases.a.capHit).toBeUndefined();
    // allowedMaxTurns still recorded so audits know the budget the run had.
    expect(checkpointState.phases.a.allowedMaxTurns).toBe(35);
  });

  it("persists 'skipped' status on the checkpoint when preCondition fails", async () => {
    phasePreConditionResult = { passed: false, reason: 'not enough material' };
    const phases = [
      phase('a', { preCondition: 'has-recent-spore-activity' }),
    ];
    const checkpointState = baseCheckpoint();
    const ctx = baseContext({
      config: baseConfig(phases),
      checkpointState,
      requestContext: {} as PhaseLoopContext['requestContext'],
    });
    await executePhasedQuery(ctx);
    expect(checkpointState.phases.a.status).toBe('skipped');
    expect(capturedExecuteInputs).toHaveLength(0);
  });

  it('gateOnPriorMetadata skips downstream phase when upstream metadata does not match — zero harness invocations', async () => {
    // upstream 'a' runs and (in this test scenario) does NOT emit
    // metadata; downstream 'b' has a gate expecting selectedTier=1
    // which won't be there. Expect b status='skipped' and only 'a'
    // hits the harness.
    const phases = [
      phase('a'),
      phase('b', {
        dependsOn: ['a'],
        gateOnPriorMetadata: { phase: 'a', key: 'selectedTier', equals: 1 },
      }),
    ];
    const checkpointState = baseCheckpoint();
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(checkpointState.phases.a.status).toBe('completed');
    expect(checkpointState.phases.b.status).toBe('skipped');
    // Only 'a' invoked the harness — 'b' short-circuited.
    expect(capturedExecuteInputs).toHaveLength(1);
  });

  it('gateOnPriorMetadata default-to-skip when upstream is missing entirely', async () => {
    // 'b' gates on a phase that doesn't exist in priorPhaseResults
    // (load-time validation normally catches this, but the runtime
    // gate must also default-to-skip rather than fail-open).
    const phases = [
      phase('a'),
      phase('b', {
        dependsOn: ['a'],
        // Use 'a' but expect a value 'a' never emits — same default-to-skip path.
        gateOnPriorMetadata: { phase: 'a', key: 'never-emitted', equals: 'expected' },
      }),
    ];
    const checkpointState = baseCheckpoint();
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);
    expect(checkpointState.phases.b.status).toBe('skipped');
    expect(checkpointState.phases.b.summary).toContain('did not match');
    expect(checkpointState.phases.b.summary).toContain('missing');
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
      harness: 'claude-sdk',
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
      harness: 'claude-sdk',
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
