/**
 * Tests for the LM Studio context-load resolver — which (model, endpoint,
 * context length) tuples a run ensures, with max-wins reconciliation.
 * Mirrors the structure of tests/agent/ollama-context.test.ts.
 *
 * The load itself is injected (`loadModel`); the real ensure path is
 * covered by tests/intelligence/lmstudio-instances.test.ts.
 */

import { describe, it, expect } from 'bun:test';
import { resolveLmStudioContextLoads } from '@myco/agent/lmstudio-context.js';
import type { ProviderConfig } from '@myco/agent/types.js';

describe('resolveLmStudioContextLoads', () => {
  function makeLoadStub() {
    const calls: Array<{ model: string; ctx: number; baseUrl: string }> = [];
    const loadModel = async (model: string, ctx: number, baseUrl: string) => {
      calls.push({ model, ctx, baseUrl });
      return true;
    };
    return { loadModel, calls };
  }

  it('passes through when there are no LM Studio providers', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = { type: 'anthropic', model: 'claude-sonnet-4-6' };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(result.taskProvider).toEqual(taskProvider);
    expect(result.phaseOverrides).toEqual({});
    expect(result.conflicts).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('applies the 32K local-default load when contextLength is unset', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      baseUrl: 'http://localhost:1234',
    };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 32_768, baseUrl: 'http://localhost:1234' },
    ]);
    expect(result.taskProvider).toMatchObject({
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 32_768,
    });
  });

  it('loads the model when contextLength is set explicitly', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
    };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 32768, baseUrl: 'http://localhost:1234' },
    ]);
    // Model name preserved (no rename), contextLength carried through.
    expect(result.taskProvider).toMatchObject({
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
    });
    expect(result.conflicts).toEqual([]);
  });

  it('recognizes an openai-compatible provider pointed at an LM Studio port', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'openai-compatible',
      model: 'openai/gpt-oss-20b',
      baseUrl: 'http://localhost:1234/v1',
      contextLength: 16384,
    };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    // Triggered via backend inference (not type === 'lmstudio'), and the
    // baseUrl is normalized to the control root for the load.
    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 16384, baseUrl: 'http://localhost:1234' },
    ]);
    expect(result.taskProvider?.contextLength).toBe(16384);
  });

  it('recognizes a localBackend: lmstudio provider', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'openai-compatible',
      localBackend: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      baseUrl: 'http://10.29.13.55:8080',
      contextLength: 16384,
    };

    await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 16384, baseUrl: 'http://10.29.13.55:8080' },
    ]);
  });

  it('does not treat an openai-compatible provider on a non-LM-Studio port as LM Studio', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'openai-compatible',
      model: 'some-model',
      baseUrl: 'http://localhost:8000/v1',
    };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(calls).toHaveLength(0);
    expect(result.taskProvider).toEqual(taskProvider);
  });

  it('keys /v1-suffixed and bare baseUrls to one load', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 16384,
      baseUrl: 'http://localhost:1234',
    };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: {
          type: 'lmstudio' as const,
          model: 'openai/gpt-oss-20b',
          contextLength: 32768,
          baseUrl: 'http://localhost:1234/v1',
        },
      },
    };

    const result = await resolveLmStudioContextLoads(taskProvider, phaseOverrides, loadModel);

    // Same endpoint after normalization → one load at the reconciled max.
    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 32768, baseUrl: 'http://localhost:1234' },
    ]);
    expect(result.conflicts).toHaveLength(1);
  });

  it('reconciles same-model-different-context to one load (max wins)', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 16384,
    };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: {
          type: 'lmstudio' as const,
          model: 'openai/gpt-oss-20b',
          contextLength: 32768, // largest — should win
        },
      },
    };

    const result = await resolveLmStudioContextLoads(taskProvider, phaseOverrides, loadModel);

    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 32768, baseUrl: 'http://localhost:1234' },
    ]);
    expect(result.taskProvider?.contextLength).toBe(32768);
    expect(result.phaseOverrides.draft.provider?.contextLength).toBe(32768);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      model: 'openai/gpt-oss-20b',
      values: [16384, 32768],
      resolved: 32768,
    });
  });

  it('treats different baseUrls as distinct loads', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 16384,
      baseUrl: 'http://host-a:1234',
    };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: {
          type: 'lmstudio' as const,
          model: 'openai/gpt-oss-20b',
          contextLength: 32768,
          baseUrl: 'http://host-b:1234',
        },
      },
    };

    const result = await resolveLmStudioContextLoads(taskProvider, phaseOverrides, loadModel);

    expect(calls).toHaveLength(2);
    const byUrl = Object.fromEntries(calls.map((c) => [c.baseUrl, c.ctx]));
    expect(byUrl['http://host-a:1234']).toBe(16384);
    expect(byUrl['http://host-b:1234']).toBe(32768);
    // No conflict — different (model, baseUrl) keys.
    expect(result.conflicts).toEqual([]);
  });

  it('skips a phase whose provider has contextLength unset (one load only)', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
    };
    const phaseOverrides = {
      draft: {
        maxTurns: 20,
        provider: { type: 'lmstudio' as const, model: 'openai/gpt-oss-20b' },
      },
    };

    await resolveLmStudioContextLoads(taskProvider, phaseOverrides, loadModel);

    // Phase override has no contextLength → defaults to 32K (the local-agent
    // default). Task scope is also 32K. Same value across scopes → one load,
    // no conflict.
    expect(calls).toEqual([
      { model: 'openai/gpt-oss-20b', ctx: 32768, baseUrl: 'http://localhost:1234' },
    ]);
  });

  it('skips providers with no model set', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      contextLength: 32768,
      baseUrl: 'http://localhost:1234',
    };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(calls).toHaveLength(0);
    expect(result.taskProvider).toEqual(taskProvider);
  });
});
