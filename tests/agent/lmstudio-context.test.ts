/**
 * Tests for the LM Studio context-load resolver.
 *
 * Stubs the timed-fetch helper so the resolver and per-model loader can
 * be exercised without a running LM Studio. Mirrors the structure of
 * tests/agent/ollama-context.test.ts.
 */

import { describe, it, expect } from 'bun:test';
import {
  resolveLmStudioContextLoads,
  ensureLmStudioModelLoaded,
  type TimedFetch,
} from '@myco/agent/lmstudio-context.js';
import type { ProviderConfig } from '@myco/agent/types.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Builds a TimedFetch stub backed by a per-URL response map. Records every
 * call so tests can assert request shape.
 */
function makeFetchStub(routes: Record<string, () => Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: TimedFetch = async (url, init) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) {
      // Default: 404 from server's perspective. Lets unmocked URLs surface.
      return new Response('not found', { status: 404 });
    }
    return handler();
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ensureLmStudioModelLoaded', () => {
  it('POSTs the documented body shape and resolves on 200', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      'http://localhost:1234/api/v1/models': () => jsonResponse({ models: [] }),
      'http://localhost:1234/api/v1/models/load': () =>
        jsonResponse({ type: 'llm', instance_id: 'i1', load_time_seconds: 1, status: 'loaded' }),
    });

    const ok = await ensureLmStudioModelLoaded(
      'openai/gpt-oss-20b',
      32768,
      'http://localhost:1234',
      fetchImpl,
    );

    expect(ok).toBe(true);
    const loadCall = calls.find((c) => c.url.endsWith('/api/v1/models/load'));
    expect(loadCall).toBeDefined();
    expect(loadCall!.init.method).toBe('POST');
    expect(JSON.parse(loadCall!.init.body as string)).toEqual({
      model: 'openai/gpt-oss-20b',
      context_length: 32768,
    });
  });

  it('skips the load when an instance is already loaded at >= requested context', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      'http://localhost:1234/api/v1/models': () =>
        jsonResponse({
          models: [
            {
              key: 'openai/gpt-oss-20b',
              loaded_instances: [{ id: 'inst-1', config: { context_length: 32768 } }],
            },
          ],
        }),
    });

    const ok = await ensureLmStudioModelLoaded(
      'openai/gpt-oss-20b',
      16384,
      'http://localhost:1234',
      fetchImpl,
    );

    expect(ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/api/v1/models/load'))).toBe(false);
  });

  it('still loads when an instance is loaded but at smaller context', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      'http://localhost:1234/api/v1/models': () =>
        jsonResponse({
          models: [
            {
              key: 'openai/gpt-oss-20b',
              loaded_instances: [{ id: 'inst-1', config: { context_length: 4096 } }],
            },
          ],
        }),
      'http://localhost:1234/api/v1/models/load': () =>
        jsonResponse({ type: 'llm', instance_id: 'i2', load_time_seconds: 2, status: 'loaded' }),
    });

    const ok = await ensureLmStudioModelLoaded(
      'openai/gpt-oss-20b',
      32768,
      'http://localhost:1234',
      fetchImpl,
    );

    expect(ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/api/v1/models/load'))).toBe(true);
  });

  it('returns false (does not throw) on 5xx', async () => {
    const fetchImpl: TimedFetch = async (url) => {
      if (url.endsWith('/api/v1/models')) return new Response('err', { status: 500 });
      return new Response('err', { status: 500 });
    };
    const ok = await ensureLmStudioModelLoaded('m', 32768, 'http://localhost:1234', fetchImpl);
    expect(ok).toBe(false);
  });

  it('returns false (does not throw) on network error', async () => {
    const fetchImpl: TimedFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const ok = await ensureLmStudioModelLoaded('m', 32768, 'http://localhost:1234', fetchImpl);
    expect(ok).toBe(false);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      'http://localhost:1234/api/v1/models': () => jsonResponse({ models: [] }),
      'http://localhost:1234/api/v1/models/load': () =>
        jsonResponse({ type: 'llm', instance_id: 'i', load_time_seconds: 1, status: 'loaded' }),
    });
    const ok = await ensureLmStudioModelLoaded('m', 8192, 'http://localhost:1234/', fetchImpl);
    expect(ok).toBe(true);
    expect(calls.map((c) => c.url)).toContain('http://localhost:1234/api/v1/models/load');
  });
});

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

  it('passes through when contextLength is unset (no default load)', async () => {
    const { loadModel, calls } = makeLoadStub();
    const taskProvider: ProviderConfig = {
      type: 'lmstudio',
      model: 'openai/gpt-oss-20b',
      baseUrl: 'http://localhost:1234',
    };

    const result = await resolveLmStudioContextLoads(taskProvider, {}, loadModel);

    expect(calls).toHaveLength(0);
    expect(result.taskProvider).toEqual(taskProvider);
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

    // The phase override's provider has no contextLength — only the task
    // scope contributes to the resolved set.
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
