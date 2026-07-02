/**
 * Unit tests for the extracted phase-loop functions.
 *
 * These tests call executePhase / executeSingleQuery / executePhasedQuery
 * directly with a hand-constructed PhaseLoopContext, bypassing runAgent's
 * DB bookkeeping. The harness adapter is mocked so dispatch goes through
 * a programmable fake instead of a real SDK.
 */

import * as __orig__myco_agent_map_phase_js__ns from '@myco/agent/map-phase.js';
const __orig__myco_agent_map_phase_js = { ...__orig__myco_agent_map_phase_js__ns };
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import type {
  EffectiveConfig,
  MapPhaseResult,
  PhaseDefinition,
  RuntimeUsage,
  HarnessId,
} from '@myco/agent/types.js';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import type { RunCheckpointState } from '@myco/agent/executor-state.js';
import { ORCHESTRATOR_PLAN_JSON_SCHEMA } from '@myco/agent/orchestrator.js';

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
let runtimeSupportsStructuredOutput = false;

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
    if (capability === 'structuredOutput') return runtimeSupportsStructuredOutput;
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

// Map-phase executor — passthrough by default, programmable per test so the
// adapter's status mapping (all-poisoned batch → failed) can be exercised
// without wiring real source/sink tools.
let mapPhaseResultOverride: MapPhaseResult | null = null;
mock.module('@myco/agent/map-phase.js', () => ({
  ...__orig__myco_agent_map_phase_js,
  executeMapPhase: async (
    input: Parameters<typeof __orig__myco_agent_map_phase_js.executeMapPhase>[0],
  ) => {
    if (mapPhaseResultOverride) return mapPhaseResultOverride;
    return __orig__myco_agent_map_phase_js.executeMapPhase(input);
  },
}));

// Per-phase preCondition resolver — programmable per test.
let phasePreConditionResult: { passed: boolean; reason: string } = { passed: true, reason: 'default-pass' };
mock.module('@myco/agent/phase-preconditions.js', () => ({
  checkPhasePreCondition: () => phasePreConditionResult,
}));

// projectScopeFromRequestContext is called only when a requestContext is
// present; tests that supply one need a non-throwing stub.
mock.module('@myco/grove/request-context.js', () => ({
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

function buildPhaseLoopContextWithOrchestratorEnabled(phaseNames: string[] = ['extract']): PhaseLoopContext {
  const phases = phaseNames.map((name) => phase(name));
  return baseContext({
    config: {
      ...baseConfig(phases),
      orchestrator: { enabled: true },
    },
  });
}

// ---------------------------------------------------------------------------
// Reset per test
// ---------------------------------------------------------------------------

beforeEach(() => {
  runtimeBehaviors = [];
  defaultRuntimeBehavior = { kind: 'success' };
  capturedExecuteInputs = [];
  runtimeSupportsSessionResume = false;
  runtimeSupportsStructuredOutput = false;
  phasePreConditionResult = { passed: true, reason: 'default-pass' };
  mapPhaseResultOverride = null;
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

  describe('map-phase batch status', () => {
    const mapPhase: PhaseDefinition = {
      name: 'describe', prompt: '', tools: [], maxTurns: 1, required: true,
      mode: 'map',
      perItemMaxTurns: 1,
      source: { tool: 'stub_source', args: {}, itemsPath: 'entries' },
      item: { prompt: 'x' },
      sink: { tool: 'stub_sink', argMap: {} },
    };

    function mapResult(overrides: Partial<MapPhaseResult>): MapPhaseResult {
      return {
        itemCount: 0,
        written: 0,
        skipped: 0,
        failed: 0,
        abandoned: 0,
        skipReasons: {},
        writeAfterThrow: 0,
        usage: {},
        ...overrides,
      };
    }

    async function runMapPhase() {
      return executePhase({
        ctx: baseContext(),
        phasePrompt: 'p',
        phaseModel: 'm',
        phase: mapPhase,
        toolSurface: { agentId: 'a', runId: 'r' },
      });
    }

    it('fails the phase when items were fetched but nothing was written (all-poisoned batch)', async () => {
      mapPhaseResultOverride = mapResult({ itemCount: 3, skipped: 3, skipReasons: { boilerplate: 3 } });
      const result = await runMapPhase();
      expect(result.status).toBe('failed');
      expect(result.summary).toContain('written=0 skipped=3');
    });

    it('fails the phase when every item failed in the harness', async () => {
      mapPhaseResultOverride = mapResult({ itemCount: 2, failed: 2 });
      const result = await runMapPhase();
      expect(result.status).toBe('failed');
      expect(result.summary).toContain('failed=2');
    });

    it('completes when at least one item was written, even with mixed failures', async () => {
      mapPhaseResultOverride = mapResult({ itemCount: 3, written: 1, skipped: 1, failed: 1 });
      const result = await runMapPhase();
      expect(result.status).toBe('completed');
      expect(result.summary).toContain('written=1');
    });

    it('completes an empty batch (nothing fetched, nothing to write)', async () => {
      mapPhaseResultOverride = mapResult({});
      const result = await runMapPhase();
      expect(result.status).toBe('completed');
    });
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

  it('forwards the resolved reasoningLevel from config into the harness execute() input', async () => {
    // Regression for the reasoningLevel plumbing gap: executeSingleQuery
    // resolves `effectiveReasoningLevel` from config.execution.reasoningLevel
    // ?? config.reasoningLevel and must forward it on baseInput, not just
    // use it to pick a model.
    const ctx = baseContext({
      config: { ...baseConfig(), reasoningLevel: 'high' },
    });
    await executeSingleQuery(ctx, 'PROMPT');
    expect(capturedExecuteInputs).toHaveLength(1);
    expect(capturedExecuteInputs[0].reasoningLevel).toBe('high');
  });

  it('prefers config.execution.reasoningLevel over the top-level config.reasoningLevel', async () => {
    const ctx = baseContext({
      config: {
        ...baseConfig(),
        reasoningLevel: 'low',
        execution: { reasoningLevel: 'high' },
      },
    });
    await executeSingleQuery(ctx, 'PROMPT');
    expect(capturedExecuteInputs[0].reasoningLevel).toBe('high');
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

  it('forwards each phase\'s resolved reasoningLevel into the harness execute() input on the wave-loop path', async () => {
    // Regression for the reasoningLevel plumbing gap: resolvePhaseExecution
    // has always resolved reasoningLevel per-phase, but the wave loop's
    // executePhase call must actually forward waveInput.reasoningLevel —
    // proven droppable by mutation before this assertion existed.
    const phases = [
      phase('a', { reasoningLevel: 'high' }),
      phase('b', { reasoningLevel: 'low' }),
    ];
    const ctx = baseContext({ config: baseConfig(phases) });
    await executePhasedQuery(ctx);

    const byPhase = new Map<string, string | undefined>();
    for (const input of capturedExecuteInputs) {
      const match = input.prompt.match(/## Current Phase: (\S+)/);
      if (match) byPhase.set(match[1], input.reasoningLevel);
    }
    expect(byPhase.get('a')).toBe('high');
    expect(byPhase.get('b')).toBe('low');
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

// ---------------------------------------------------------------------------
// executePhasedQuery — allocation-based turnOffset
// ---------------------------------------------------------------------------

describe('executePhasedQuery turnOffset allocation', () => {
  function offsetsByPrompt(): Map<string, number | undefined> {
    const out = new Map<string, number | undefined>();
    for (const input of capturedExecuteInputs) {
      const match = input.prompt.match(/## Current Phase: (\S+)/);
      if (match) out.set(match[1], input.toolSurface?.turnOffset);
    }
    return out;
  }

  it('within a wave, each phase offset is the prefix sum of preceding siblings maxTurns', async () => {
    const phases = [
      phase('a', { maxTurns: 3 }),
      phase('b', { maxTurns: 10 }),
    ];
    const ctx = baseContext({ config: baseConfig(phases) });
    await executePhasedQuery(ctx);

    const offsets = offsetsByPrompt();
    expect(offsets.get('a')).toBe(0);
    expect(offsets.get('b')).toBe(3);
  });

  it('advances the cross-wave base by the wave\'s total ALLOCATED turns, not turns used', async () => {
    // Each phase actually uses 1 turn (DEFAULT_USAGE.requests = 1); the
    // second wave must still start at 3 + 10 = 13.
    const phases = [
      phase('a', { maxTurns: 3 }),
      phase('b', { maxTurns: 10 }),
      phase('c', { maxTurns: 4, dependsOn: ['a', 'b'] }),
    ];
    const ctx = baseContext({ config: baseConfig(phases) });
    await executePhasedQuery(ctx);

    const offsets = offsetsByPrompt();
    expect(offsets.get('a')).toBe(0);
    expect(offsets.get('b')).toBe(3);
    expect(offsets.get('c')).toBe(13);
  });

  it('keeps the same offsets on resume — completed phases still occupy their allocated range', async () => {
    const phases = [
      phase('a', { maxTurns: 3 }),
      phase('b', { maxTurns: 10 }),
      phase('c', { maxTurns: 4, dependsOn: ['a', 'b'] }),
    ];
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        a: { name: 'a', status: 'completed', summary: 'done', turnsUsed: 1, updatedAt: 0 },
      },
    };
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);

    const offsets = offsetsByPrompt();
    expect(offsets.has('a')).toBe(false);
    expect(offsets.get('b')).toBe(3);
    expect(offsets.get('c')).toBe(13);
  });

  it('starts a later wave at the full allocation even when the entire first wave was restored', async () => {
    const phases = [
      phase('a', { maxTurns: 3 }),
      phase('b', { maxTurns: 10 }),
      phase('c', { maxTurns: 4, dependsOn: ['a', 'b'] }),
    ];
    const checkpointState: RunCheckpointState = {
      harness: 'claude-sdk',
      phases: {
        a: { name: 'a', status: 'completed', summary: 'done', turnsUsed: 1, updatedAt: 0 },
        b: { name: 'b', status: 'completed', summary: 'done', turnsUsed: 2, updatedAt: 0 },
      },
    };
    const ctx = baseContext({ config: baseConfig(phases), checkpointState });
    await executePhasedQuery(ctx);

    const offsets = offsetsByPrompt();
    expect(capturedExecuteInputs).toHaveLength(1);
    expect(offsets.get('c')).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// executePhasedQuery — orchestrator structured output
// ---------------------------------------------------------------------------

describe('executePhasedQuery orchestrator structured output', () => {
  it('forwards the orchestrator-resolved reasoningLevel into the orchestrator\'s execute() input', async () => {
    // Regression for the reasoningLevel plumbing gap on the orchestrator
    // block: orchestratorReasoningLevel is resolved as
    // config.orchestrator.reasoningLevel ?? config.execution?.reasoningLevel
    // ?? config.reasoningLevel, and that resolved value must reach the
    // orchestrator's own harness.execute() call (identified here by its
    // empty toolNames, which only the orchestrator call sets).
    runtimeBehaviors = [
      { kind: 'success', result: { finalText: '{"phases":[],"reasoning":"unused"}' } },
    ];
    const phases = [phase('extract')];
    const ctx = baseContext({
      config: {
        ...baseConfig(phases),
        reasoningLevel: 'low',
        orchestrator: { enabled: true, reasoningLevel: 'high' },
      } as EffectiveConfig,
    });
    await executePhasedQuery(ctx);
    const orchestratorCall = capturedExecuteInputs.find((input) => input.toolSurface.toolNames?.length === 0);
    expect(orchestratorCall?.reasoningLevel).toBe('high');
  });

  it('falls back through config.execution.reasoningLevel then config.reasoningLevel when orchestrator.reasoningLevel is unset', async () => {
    runtimeBehaviors = [
      { kind: 'success', result: { finalText: '{"phases":[],"reasoning":"unused"}' } },
    ];
    const phases = [phase('extract')];
    const ctx = baseContext({
      config: {
        ...baseConfig(phases),
        reasoningLevel: 'low',
        execution: { reasoningLevel: 'high' },
        orchestrator: { enabled: true },
      },
    });
    await executePhasedQuery(ctx);
    const orchestratorCall = capturedExecuteInputs.find((input) => input.toolSurface.toolNames?.length === 0);
    expect(orchestratorCall?.reasoningLevel).toBe('high');
  });

  it('requests outputSchema on the orchestrator call when the harness supports structuredOutput', async () => {
    runtimeSupportsStructuredOutput = true;
    runtimeBehaviors = [
      { kind: 'success', result: { finalText: '{"phases":[],"reasoning":"structured path unused for this assertion"}' } },
    ];
    await executePhasedQuery(buildPhaseLoopContextWithOrchestratorEnabled());
    const orchestratorCall = capturedExecuteInputs.find((input) => input.toolSurface.toolNames?.length === 0);
    expect(orchestratorCall?.outputSchema).toEqual({
      name: 'orchestrator_plan',
      schema: ORCHESTRATOR_PLAN_JSON_SCHEMA,
    });
  });

  it('does not request outputSchema when the harness does not support structuredOutput', async () => {
    runtimeSupportsStructuredOutput = false;
    runtimeBehaviors = [
      { kind: 'success', result: { finalText: '{"phases":[],"reasoning":"text path"}' } },
    ];
    await executePhasedQuery(buildPhaseLoopContextWithOrchestratorEnabled());
    const orchestratorCall = capturedExecuteInputs.find((input) => input.toolSurface.toolNames?.length === 0);
    expect(orchestratorCall?.outputSchema).toBeUndefined();
  });

  it('applies directives from structuredOutput when the harness returns it', async () => {
    runtimeSupportsStructuredOutput = true;
    runtimeBehaviors = [
      {
        kind: 'success',
        result: {
          finalText: '{"phases":[],"reasoning":"should not be used"}',
          structuredOutput: {
            phases: [{ name: 'extract', skip: true, skipReason: 'nothing pending' }],
            reasoning: 'structured plan used directly',
          },
        },
      },
    ];
    const ctx = buildPhaseLoopContextWithOrchestratorEnabled(['extract', 'graph']);
    const result = await executePhasedQuery(ctx);
    const executedPhaseNames = result.phases.map((p) => p.name);
    expect(executedPhaseNames).not.toContain('extract');
    expect(executedPhaseNames).toContain('graph');
  });

  it('falls back to text parsing when structuredOutput is undefined despite harness support', async () => {
    runtimeSupportsStructuredOutput = true;
    runtimeBehaviors = [
      {
        kind: 'success',
        result: {
          finalText: '{"phases":[{"name":"extract","skip":true,"skipReason":"nothing pending"}],"reasoning":"fallback text plan"}',
          structuredOutput: undefined,
        },
      },
    ];
    const ctx = buildPhaseLoopContextWithOrchestratorEnabled(['extract', 'graph']);
    const result = await executePhasedQuery(ctx);
    const executedPhaseNames = result.phases.map((p) => p.name);
    expect(executedPhaseNames).not.toContain('extract');
    expect(executedPhaseNames).toContain('graph');
  });

  it('warns "structured-output-missing" once when the schema\'d call succeeds but returns no structuredOutput, then falls back to text parsing', async () => {
    // Soft-failure path: outputSchema WAS attached, the call did NOT throw,
    // but the provider's structured-output validation failed after its own
    // retries (e.g. Claude's error_max_structured_output_retries subtype —
    // empty finalText, no structured_output on the result message). This is
    // distinct from the throw-and-retry path above, which never has
    // outputSchema attached on its retry and therefore never double-warns
    // here.
    runtimeSupportsStructuredOutput = true;
    runtimeBehaviors = [
      {
        kind: 'success',
        result: {
          finalText: '{"phases":[{"name":"extract","skip":true,"skipReason":"nothing pending"}],"reasoning":"fallback text plan"}',
          structuredOutput: undefined,
        },
      },
    ];
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    const ctx = buildPhaseLoopContextWithOrchestratorEnabled(['extract', 'graph']);
    ctx.options = { logger };

    const result = await executePhasedQuery(ctx);

    expect(warn).toHaveBeenCalledTimes(1);
    const [kind, , meta] = warn.mock.calls[0];
    expect(kind).toBe('agent.orchestrator.structured-output-missing');
    expect(meta).toMatchObject({ runId: 'run-123' });

    const executedPhaseNames = result.phases.map((p) => p.name);
    expect(executedPhaseNames).not.toContain('extract');
    expect(executedPhaseNames).toContain('graph');
  });

  it('retries without outputSchema exactly once when the harness throws on the structured-output call, and uses the retry result', async () => {
    runtimeSupportsStructuredOutput = true;
    runtimeBehaviors = [
      { kind: 'error', message: 'malformed structured output JSON' },
      {
        kind: 'success',
        result: {
          finalText: '{"phases":[{"name":"extract","skip":true,"skipReason":"nothing pending"}],"reasoning":"retry text plan"}',
        },
      },
    ];
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    const ctx = buildPhaseLoopContextWithOrchestratorEnabled(['extract', 'graph']);
    ctx.options = { logger };

    const result = await executePhasedQuery(ctx);

    // The orchestrator planning calls always happen before any phase
    // executes, so the first two captured inputs are the initial
    // structured-output attempt and its no-outputSchema retry.
    const orchestratorCalls = capturedExecuteInputs.slice(0, 2);
    expect(orchestratorCalls[0].outputSchema).toEqual({
      name: 'orchestrator_plan',
      schema: ORCHESTRATOR_PLAN_JSON_SCHEMA,
    });
    expect(orchestratorCalls[1].outputSchema).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const [kind, , meta] = warn.mock.calls[0];
    expect(kind).toBe('agent.orchestrator.structured-output-failed');
    expect(meta?.error).toContain('malformed structured output JSON');

    const executedPhaseNames = result.phases.map((p) => p.name);
    expect(executedPhaseNames).not.toContain('extract');
    expect(executedPhaseNames).toContain('graph');
  });
});
