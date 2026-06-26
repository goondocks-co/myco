// tests/agent/harness/provider-health.test.ts
import { describe, expect, test } from 'bun:test';
import { __setProviderHealthBackendFactory, probeProviderAvailable, __resetProviderHealthCache } from '@myco/agent/harness/provider-health.js';

function fakeBackend(available: boolean, calls: { n: number }) {
  return { isAvailable: async () => { calls.n++; return available; } };
}

describe('probeProviderAvailable', () => {
  test('local provider down → false', async () => {
    __resetProviderHealthCache();
    const calls = { n: 0 };
    __setProviderHealthBackendFactory(() => fakeBackend(false, calls));
    const ok = await probeProviderAvailable({ type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' } as any);
    expect(ok).toBe(false);
  });

  test('result cached within TTL (one probe for two calls)', async () => {
    __resetProviderHealthCache();
    const calls = { n: 0 };
    let t = 1000;
    __setProviderHealthBackendFactory(() => fakeBackend(true, calls));
    const opts = { now: () => t };
    await probeProviderAvailable({ type: 'ollama', baseUrl: 'http://y:11434', model: 'm' } as any, opts);
    t += 1000; // within 5s TTL
    await probeProviderAvailable({ type: 'ollama', baseUrl: 'http://y:11434', model: 'm' } as any, opts);
    expect(calls.n).toBe(1);
  });

  test('distinct baseUrls do not share a cache entry', async () => {
    __resetProviderHealthCache();
    const calls = { n: 0 };
    __setProviderHealthBackendFactory(() => fakeBackend(true, calls));
    await probeProviderAvailable({ type: 'lmstudio', baseUrl: 'http://a:1234', model: 'm' } as any);
    await probeProviderAvailable({ type: 'lmstudio', baseUrl: 'http://b:1234', model: 'm' } as any);
    expect(calls.n).toBe(2); // not collapsed to one key
  });

  test('cache entry expires after TTL → re-probes', async () => {
    __resetProviderHealthCache();
    const calls = { n: 0 };
    __setProviderHealthBackendFactory(() => fakeBackend(true, calls));
    let t = 1000;
    const opts = { now: () => t };
    await probeProviderAvailable({ type: 'ollama', baseUrl: 'http://y:11434', model: 'm' } as any, opts);
    t += 6000; // past 5s TTL
    await probeProviderAvailable({ type: 'ollama', baseUrl: 'http://y:11434', model: 'm' } as any, opts);
    expect(calls.n).toBe(2);
  });

  test('cloud provider with no baseUrl → true without a local probe', async () => {
    __resetProviderHealthCache();
    const ok = await probeProviderAvailable({ type: 'anthropic', model: 'claude-sonnet-4-6' } as any);
    expect(ok).toBe(true);
  });
});
