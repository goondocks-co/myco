/**
 * Tests for the Ollama context variant resolver.
 *
 * Exercises `resolveOllamaContextVariants` in isolation by injecting a pure
 * stub variant-creator — no `ollama` CLI required. Covers the default,
 * explicit overrides, same-model multi-scope reconciliation, non-ollama
 * pass-through, and the phase-override rewriting.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveOllamaContextVariants,
  DEFAULT_OLLAMA_CONTEXT_LENGTH,
} from '@myco/agent/ollama-context.js';
import type { ProviderConfig } from '@myco/agent/types.js';

/**
 * Deterministic stub that mirrors the naming scheme of the real
 * `ensureOllamaContextVariant` without touching disk or invoking `ollama`.
 * Also records every invocation so tests can assert the resolver created
 * the expected set of variants.
 */
function makeStubCreator() {
  const calls: Array<{ model: string; ctx: number }> = [];
  const createVariant = async (model: string, ctx: number) => {
    calls.push({ model, ctx });
    return `${model}-ctx${ctx}`;
  };
  return { createVariant, calls };
}

describe('resolveOllamaContextVariants', () => {
  it('passes through when there are no Ollama providers', async () => {
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = { type: 'cloud', model: 'claude-sonnet-4-6' };

    const result = await resolveOllamaContextVariants(taskProvider, {}, createVariant);

    expect(result.taskProvider).toEqual(taskProvider);
    expect(result.phaseOverrides).toEqual({});
    expect(result.conflicts).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('applies DEFAULT_OLLAMA_CONTEXT_LENGTH when context_length is unset', async () => {
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = {
      type: 'ollama',
      model: 'gemma4:26b',
      baseUrl: 'http://localhost:11434',
    };

    const result = await resolveOllamaContextVariants(taskProvider, {}, createVariant);

    // The variant should be created at the default, and the rewritten
    // provider should carry both the variant model name and the default
    // contextLength (so downstream code sees the effective value).
    expect(calls).toEqual([{ model: 'gemma4:26b', ctx: DEFAULT_OLLAMA_CONTEXT_LENGTH }]);
    expect(result.taskProvider).toMatchObject({
      type: 'ollama',
      model: `gemma4:26b-ctx${DEFAULT_OLLAMA_CONTEXT_LENGTH}`,
      contextLength: DEFAULT_OLLAMA_CONTEXT_LENGTH,
      baseUrl: 'http://localhost:11434',
    });
    expect(result.conflicts).toEqual([]);
  });

  it('respects an explicit context_length value', async () => {
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = {
      type: 'ollama',
      model: 'gemma4:26b',
      contextLength: 16384,
    };

    const result = await resolveOllamaContextVariants(taskProvider, {}, createVariant);

    expect(calls).toEqual([{ model: 'gemma4:26b', ctx: 16384 }]);
    expect(result.taskProvider).toMatchObject({
      model: 'gemma4:26b-ctx16384',
      contextLength: 16384,
    });
  });

  it('rewrites phase-level Ollama providers too, not just the task level', async () => {
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = {
      type: 'ollama',
      model: 'gemma4:26b',
      contextLength: 32768,
    };
    const phaseOverrides = {
      draft: { maxTurns: 20 },  // inherits task provider
      validate: {
        maxTurns: 30,
        provider: { type: 'ollama' as const, model: 'qwen:14b' },
      },
    };

    const result = await resolveOllamaContextVariants(taskProvider, phaseOverrides, createVariant);

    // Two distinct models → two variant creations.
    expect(calls).toHaveLength(2);
    const callModels = new Set(calls.map((c) => c.model));
    expect(callModels).toEqual(new Set(['gemma4:26b', 'qwen:14b']));

    // Phase that inherits from task provider has no provider override of
    // its own, so it stays unchanged — the task-level rewrite handles it.
    expect(result.phaseOverrides.draft).toEqual({ maxTurns: 20 });

    // Phase that overrides the provider should get its provider rewritten
    // to the variant name, with the default context length applied.
    expect(result.phaseOverrides.validate.provider).toMatchObject({
      type: 'ollama',
      model: `qwen:14b-ctx${DEFAULT_OLLAMA_CONTEXT_LENGTH}`,
      contextLength: DEFAULT_OLLAMA_CONTEXT_LENGTH,
    });
  });

  it('reconciles same-model-different-context to a single variant (max wins)', async () => {
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = {
      type: 'ollama',
      model: 'gemma4:26b',
      contextLength: 16384,
    };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: {
          type: 'ollama' as const,
          model: 'gemma4:26b',
          contextLength: 8192,
        },
      },
      validate: {
        maxTurns: 30,
        provider: {
          type: 'ollama' as const,
          model: 'gemma4:26b',
          contextLength: 32768, // largest — should win
        },
      },
    };

    const result = await resolveOllamaContextVariants(taskProvider, phaseOverrides, createVariant);

    // Exactly ONE variant created, at the max context.
    expect(calls).toEqual([{ model: 'gemma4:26b', ctx: 32768 }]);

    // Every scope that referenced gemma4:26b gets rewritten to the same
    // variant name with the reconciled context length.
    expect(result.taskProvider?.model).toBe('gemma4:26b-ctx32768');
    expect(result.taskProvider?.contextLength).toBe(32768);
    expect(result.phaseOverrides.draft.provider?.model).toBe('gemma4:26b-ctx32768');
    expect(result.phaseOverrides.draft.provider?.contextLength).toBe(32768);
    expect(result.phaseOverrides.validate.provider?.model).toBe('gemma4:26b-ctx32768');

    // The conflict is surfaced so the caller can log/warn.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      model: 'gemma4:26b',
      values: [8192, 16384, 32768],
      resolved: 32768,
    });
  });

  it('does not report a conflict when all scopes resolve to the same value', async () => {
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = {
      type: 'ollama',
      model: 'gemma4:26b',
      contextLength: 32768,
    };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: { type: 'ollama' as const, model: 'gemma4:26b', contextLength: 32768 },
      },
    };

    const result = await resolveOllamaContextVariants(taskProvider, phaseOverrides, createVariant);

    expect(calls).toEqual([{ model: 'gemma4:26b', ctx: 32768 }]);
    expect(result.conflicts).toEqual([]);
  });

  it('handles cloud task provider with ollama phase override', async () => {
    // The inverse of the user's planned per-phase model split: cloud for
    // the task baseline, ollama for a specific phase. The ollama phase
    // should still get a variant with the default context.
    const { createVariant, calls } = makeStubCreator();
    const taskProvider: ProviderConfig = { type: 'cloud', model: 'claude-sonnet-4-6' };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: { type: 'ollama' as const, model: 'gemma4:26b' },
      },
    };

    const result = await resolveOllamaContextVariants(taskProvider, phaseOverrides, createVariant);

    // Task provider is cloud — pass through untouched.
    expect(result.taskProvider).toEqual(taskProvider);

    // Phase provider is ollama — variant created with default context.
    expect(calls).toEqual([{ model: 'gemma4:26b', ctx: DEFAULT_OLLAMA_CONTEXT_LENGTH }]);
    expect(result.phaseOverrides.draft.provider?.model).toBe(
      `gemma4:26b-ctx${DEFAULT_OLLAMA_CONTEXT_LENGTH}`,
    );
  });

  it('skips providers with no model set', async () => {
    const { createVariant, calls } = makeStubCreator();
    // Incomplete config: type is ollama but no model — should be left alone.
    const taskProvider: ProviderConfig = { type: 'ollama', baseUrl: 'http://localhost:11434' };

    const result = await resolveOllamaContextVariants(taskProvider, {}, createVariant);

    expect(calls).toHaveLength(0);
    expect(result.taskProvider).toEqual(taskProvider);
  });
});
