// tests/agent/harness/provider-health.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { __setProviderHealthBackendFactory, probeProviderAvailable, __resetProviderHealthCache } from '@myco/agent/harness/provider-health.js';

function fakeBackend(available: boolean, calls: { n: number }) {
  return { isAvailable: async () => { calls.n++; return available; } };
}

describe('probeProviderAvailable', () => {
  test('local provider down → unavailable, no reason', async () => {
    __resetProviderHealthCache();
    const calls = { n: 0 };
    __setProviderHealthBackendFactory(() => fakeBackend(false, calls));
    const result = await probeProviderAvailable({ type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' } as any);
    expect(result).toEqual({ available: false });
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

  test('cloud provider with no baseUrl and a key present → available without a local probe', async () => {
    __resetProviderHealthCache();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    try {
      const result = await probeProviderAvailable({ type: 'anthropic', model: 'claude-sonnet-4-6' } as any);
      expect(result).toEqual({ available: true });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('probeProviderAvailable — missing-key detection', () => {
  const KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'MYCO_OPENAI_API_KEY', 'OPENAI_API_KEY', 'MYCO_OPENROUTER_API_KEY'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    __resetProviderHealthCache();
    saved = {};
    for (const k of KEY_ENV_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEY_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('no explicit provider (claude-sdk subscription default) → available, missing_key never applies', async () => {
    const result = await probeProviderAvailable(undefined);
    expect(result).toEqual({ available: true });
  });

  test('anthropic provider with no ANTHROPIC_API_KEY anywhere in env → missing_key', async () => {
    const result = await probeProviderAvailable({ type: 'anthropic', model: 'claude-sonnet-4-6' } as any);
    expect(result).toEqual({ available: false, reason: 'missing_key' });
  });

  test('anthropic provider with ANTHROPIC_API_KEY set → available, no local probe attempted', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const result = await probeProviderAvailable({ type: 'anthropic', model: 'claude-sonnet-4-6' } as any);
    expect(result).toEqual({ available: true });
  });

  test('openai provider with neither MYCO_OPENAI_API_KEY nor OPENAI_API_KEY → missing_key', async () => {
    const result = await probeProviderAvailable({ type: 'openai', model: 'gpt-5' } as any);
    expect(result).toEqual({ available: false, reason: 'missing_key' });
  });

  test('openai provider with MYCO_OPENAI_API_KEY set → available', async () => {
    process.env.MYCO_OPENAI_API_KEY = 'sk-openai-test';
    const result = await probeProviderAvailable({ type: 'openai', model: 'gpt-5' } as any);
    expect(result).toEqual({ available: true });
  });

  test('openrouter provider with no MYCO_OPENROUTER_API_KEY → missing_key', async () => {
    const result = await probeProviderAvailable({ type: 'openrouter', model: 'x' } as any);
    expect(result).toEqual({ available: false, reason: 'missing_key' });
  });

  test('ollama provider never requires a stored key — missing_key does not apply', async () => {
    const calls = { n: 0 };
    __setProviderHealthBackendFactory(() => fakeBackend(true, calls));
    const result = await probeProviderAvailable({ type: 'ollama', baseUrl: 'http://y:11434', model: 'm' } as any);
    expect(result).toEqual({ available: true });
  });

  test('openai-compatible provider never requires a stored key — missing_key does not apply', async () => {
    const calls = { n: 0 };
    __setProviderHealthBackendFactory(() => fakeBackend(true, calls));
    const result = await probeProviderAvailable({ type: 'openai-compatible', baseUrl: 'http://z:8080', model: 'm' } as any);
    expect(result).toEqual({ available: true });
  });

  test('missing-key result is never cached — a key added between calls is picked up immediately', async () => {
    const first = await probeProviderAvailable({ type: 'anthropic', model: 'm' } as any);
    expect(first).toEqual({ available: false, reason: 'missing_key' });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-late';
    const second = await probeProviderAvailable({ type: 'anthropic', model: 'm' } as any);
    expect(second).toEqual({ available: true });
  });
});
