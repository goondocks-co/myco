import { describe, it, expect, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { LmStudioBackend } from '@myco/intelligence/lm-studio';

// LmStudioBackend is the embedding + availability client only. Text
// generation goes through the openai-agents harness, and model-instance
// lifecycle (load/unload/loaded state) is covered by
// tests/intelligence/lmstudio-instances.test.ts.

/** Capture fetch calls and return canned responses. */
function mockFetch(handlers: Record<string, (body: any) => unknown>) {
  const calls: Array<{ url: string; method: string; body: any }> = [];

  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: urlStr, method, body });

    for (const [pattern, handler] of Object.entries(handlers)) {
      if (urlStr.includes(pattern)) {
        const data = handler(body);
        return new Response(JSON.stringify(data), { status: 200 });
      }
    }
    return new Response('Not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

function makeBackend(overrides: Record<string, unknown> = {}) {
  return new LmStudioBackend({
    model: 'test-model',
    base_url: 'http://localhost:9999',
    ...overrides,
  });
}

describe('LmStudioBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('embed', () => {
    it('POSTs the configured model and input to the OpenAI-compat endpoint', async () => {
      const { calls } = mockFetch({
        '/v1/embeddings': () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          model: 'test-model',
        }),
      });

      const backend = makeBackend();
      const result = await backend.embed('some text');

      const call = calls.find((c) => c.url.includes('/v1/embeddings'));
      expect(call).toBeDefined();
      expect(call!.method).toBe('POST');
      expect(call!.body).toEqual({ model: 'test-model', input: 'some text' });
      expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(result.dimensions).toBe(3);
    });

    it('throws on a non-OK response', async () => {
      mockFetch({});
      const backend = makeBackend();
      await expect(backend.embed('x')).rejects.toThrow(/404/);
    });
  });

  describe('isAvailable', () => {
    it('is true when the models list responds OK', async () => {
      mockFetch({ '/v1/models': () => ({ data: [] }) });
      expect(await makeBackend().isAvailable()).toBe(true);
    });

    it('is false when the server is unreachable', async () => {
      const mock = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof globalThis.fetch;
      vi.stubGlobal('fetch', mock);
      expect(await makeBackend().isAvailable()).toBe(false);
    });
  });

  describe('listModels', () => {
    it('returns model ids from the OpenAI-compat list', async () => {
      mockFetch({
        '/v1/models': () => ({ data: [{ id: 'a' }, { id: 'b' }] }),
      });
      expect(await makeBackend().listModels()).toEqual(['a', 'b']);
    });

    it('returns [] on failure', async () => {
      const mock = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof globalThis.fetch;
      vi.stubGlobal('fetch', mock);
      expect(await makeBackend().listModels()).toEqual([]);
    });
  });
});
