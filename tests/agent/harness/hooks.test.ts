/**
 * Structural tests for the HarnessHooks type — verifies the shape compiles
 * and that a partial implementation (only some hooks registered) is valid,
 * since HarnessHooks fields are all optional.
 */

import { describe, it, expect } from 'bun:test';
import type {
  HarnessHookContext,
  PreToolUseEvent,
  PostToolUseEvent,
  PhaseStartEvent,
  PhaseEndEvent,
  HarnessHooks,
} from '@myco/agent/harness/hooks.js';

describe('HarnessHooks', () => {
  it('accepts a fully-populated hooks object and invokes each callback with the right event shape', async () => {
    const calls: string[] = [];
    const ctx: HarnessHookContext = {
      runId: 'run-1',
      agentId: 'agent-1',
      harnessId: 'claude-sdk',
      phaseName: 'gather',
    };

    const hooks: HarnessHooks = {
      preToolUse: (event: PreToolUseEvent) => {
        expect(event.toolName).toBe('vault_spores');
        expect(event.runId).toBe('run-1');
        calls.push('preToolUse');
      },
      postToolUse: (event: PostToolUseEvent) => {
        expect(event.outcome).toBe('success');
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
        calls.push('postToolUse');
      },
      phaseStart: (event: PhaseStartEvent) => {
        expect(event.phaseName).toBe('gather');
        expect(event.required).toBe(true);
        calls.push('phaseStart');
      },
      phaseEnd: (event: PhaseEndEvent) => {
        expect(event.status).toBe('completed');
        calls.push('phaseEnd');
      },
    };

    await hooks.phaseStart?.({ ...ctx, phaseName: 'gather', model: 'claude-sonnet-4-6', maxTurns: 8, required: true });
    await hooks.preToolUse?.({ ...ctx, toolName: 'vault_spores', toolInput: { limit: 10 } });
    await hooks.postToolUse?.({ ...ctx, toolName: 'vault_spores', toolInput: { limit: 10 }, outcome: 'success', durationMs: 12 });
    await hooks.phaseEnd?.({ ...ctx, phaseName: 'gather', status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.01, durationMs: 900 });

    expect(calls).toEqual(['phaseStart', 'preToolUse', 'postToolUse', 'phaseEnd']);
  });

  it('allows an empty hooks object — every field is optional', () => {
    const hooks: HarnessHooks = {};
    expect(hooks.preToolUse).toBeUndefined();
    expect(hooks.postToolUse).toBeUndefined();
    expect(hooks.phaseStart).toBeUndefined();
    expect(hooks.phaseEnd).toBeUndefined();
  });

  it('PostToolUseEvent carries errorMessage only conceptually on the error path (type-level check)', () => {
    const errorEvent: PostToolUseEvent = {
      runId: 'run-1', agentId: 'agent-1', harnessId: 'openai-agents',
      toolName: 'vault_create_spore', toolInput: {}, outcome: 'error',
      errorMessage: 'insert failed', durationMs: 5,
    };
    expect(errorEvent.outcome).toBe('error');
    expect(errorEvent.errorMessage).toBe('insert failed');
  });
});
