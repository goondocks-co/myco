import { describe, it, expect, vi, afterEach } from 'vitest';
import { LmStudioBackend } from '@myco/intelligence/lm-studio';

// --- Helpers ---

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
    context_window: 65536,
    max_tokens: 1024,
    ...overrides,
  });
}

// --- Tests ---

describe('LmStudioBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('summarize', () => {
    it('always includes context_length in request body', async () => {
      const { calls } = mockFetch({
        '/api/v1/chat': () => ({
          model_instance_id: 'test-model',
          output: [{ type: 'message', content: 'response' }],
        }),
      });

      const backend = makeBackend();
      await backend.summarize('test prompt');

      const chatCall = calls.find((c) => c.url.includes('/api/v1/chat'));
      expect(chatCall).toBeDefined();
      expect(chatCall!.body.context_length).toBe(65536);
    });

    it('uses per-request contextLength when provided', async () => {
      const { calls } = mockFetch({
        '/api/v1/chat': () => ({
          model_instance_id: 'test-model',
          output: [{ type: 'message', content: 'response' }],
        }),
      });

      const backend = makeBackend();
      await backend.summarize('test prompt', { contextLength: 32768 });

      const chatCall = calls.find((c) => c.url.includes('/api/v1/chat'));
      expect(chatCall!.body.context_length).toBe(32768);
    });

    it('routes by instance ID after ensureLoaded', async () => {
      const { calls } = mockFetch({
        '/api/v1/models/load': () => ({ instance_id: 'test-model:3', status: 'loaded' }),
        '/api/v1/models': () => ({ models: [{ key: 'test-model', loaded_instances: [] }] }),
        '/api/v1/chat': () => ({
          model_instance_id: 'test-model:3',
          output: [{ type: 'message', content: 'response' }],
        }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);
      await backend.summarize('test prompt');

      const chatCall = calls.find((c) => c.url.includes('/api/v1/chat'));
      expect(chatCall!.body.model).toBe('test-model:3');
      // context_length still sent alongside instance ID
      expect(chatCall!.body.context_length).toBe(65536);
    });

    it('falls back to model name when no instance ID', async () => {
      const { calls } = mockFetch({
        '/api/v1/chat': () => ({
          model_instance_id: 'test-model',
          output: [{ type: 'message', content: 'response' }],
        }),
      });

      const backend = makeBackend();
      // No ensureLoaded — instanceId is null
      await backend.summarize('test prompt');

      const chatCall = calls.find((c) => c.url.includes('/api/v1/chat'));
      expect(chatCall!.body.model).toBe('test-model');
    });

    it('clears instance ID on 404 for self-healing', async () => {
      mockFetch({
        '/api/v1/models/load': () => ({ instance_id: 'test-model:3', status: 'loaded' }),
        '/api/v1/models': () => ({ models: [{ key: 'test-model', loaded_instances: [] }] }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);

      // Now mock a 404 on chat
      vi.restoreAllMocks();
      const { calls } = mockFetch({});
      // No chat handler → returns 404

      await expect(backend.summarize('test')).rejects.toThrow(/404/);

      // Next summarize should use model name (instance ID was cleared)
      vi.restoreAllMocks();
      const round2 = mockFetch({
        '/api/v1/chat': () => ({
          model_instance_id: 'test-model',
          output: [{ type: 'message', content: 'ok' }],
        }),
      });

      await backend.summarize('test');
      const chatCall = round2.calls.find((c) => c.url.includes('/api/v1/chat'));
      expect(chatCall!.body.model).toBe('test-model');
    });
  });

  describe('ensureLoaded', () => {
    it('reuses compatible instance without loading', async () => {
      const { calls } = mockFetch({
        '/api/v1/models': () => ({
          models: [{
            key: 'test-model',
            loaded_instances: [{
              id: 'test-model:1',
              config: { context_length: 65536, offload_kv_cache_to_gpu: false },
            }],
          }],
        }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);

      const loadCalls = calls.filter((c) => c.url.includes('/models/load'));
      expect(loadCalls).toHaveLength(0);
    });

    it('loads new instance when none exist', async () => {
      const { calls } = mockFetch({
        '/api/v1/models/load': () => ({ instance_id: 'test-model:1', status: 'loaded' }),
        '/api/v1/models': () => ({
          models: [{ key: 'test-model', loaded_instances: [] }],
        }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);

      const loadCall = calls.find((c) => c.url.includes('/models/load'));
      expect(loadCall).toBeDefined();
      expect(loadCall!.body.model).toBe('test-model');
      expect(loadCall!.body.context_length).toBe(65536);
      expect(loadCall!.body.offload_kv_cache_to_gpu).toBe(false);
    });

    it('loads own instance without unloading incompatible ones', async () => {
      const { calls } = mockFetch({
        '/api/v1/models/load': () => ({ instance_id: 'test-model:3', status: 'loaded' }),
        '/api/v1/models': () => ({
          models: [{
            key: 'test-model',
            loaded_instances: [{
              id: 'test-model:1',
              config: { context_length: 32768, offload_kv_cache_to_gpu: true },
            }],
          }],
        }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);

      // Should NOT unload the other instance
      const unloadCalls = calls.filter((c) => c.url.includes('/models/unload'));
      expect(unloadCalls).toHaveLength(0);

      // Should load our own
      const loadCall = calls.find((c) => c.url.includes('/models/load'));
      expect(loadCall).toBeDefined();
      expect(loadCall!.body.offload_kv_cache_to_gpu).toBe(false);
    });

    it('captures instance ID from load response', async () => {
      const { calls } = mockFetch({
        '/api/v1/models/load': () => ({ instance_id: 'test-model:5', status: 'loaded' }),
        '/api/v1/models': () => ({
          models: [{ key: 'test-model', loaded_instances: [] }],
        }),
        '/api/v1/chat': () => ({
          model_instance_id: 'test-model:5',
          output: [{ type: 'message', content: 'ok' }],
        }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);
      await backend.summarize('test');

      const chatCall = calls.find((c) => c.url.includes('/api/v1/chat'));
      expect(chatCall!.body.model).toBe('test-model:5');
    });

    it('reuses compatible instance from another daemon', async () => {
      const { calls } = mockFetch({
        '/api/v1/models': () => ({
          models: [{
            key: 'test-model',
            loaded_instances: [
              {
                id: 'test-model:1',
                config: { context_length: 32768, offload_kv_cache_to_gpu: true },
              },
              {
                id: 'test-model:2',
                config: { context_length: 65536, offload_kv_cache_to_gpu: false },
              },
            ],
          }],
        }),
      });

      const backend = makeBackend();
      await backend.ensureLoaded(65536, false);

      // Should reuse :2 without loading or unloading
      const loadCalls = calls.filter((c) => c.url.includes('/models/load'));
      expect(loadCalls).toHaveLength(0);
      const unloadCalls = calls.filter((c) => c.url.includes('/models/unload'));
      expect(unloadCalls).toHaveLength(0);
    });
  });
});
