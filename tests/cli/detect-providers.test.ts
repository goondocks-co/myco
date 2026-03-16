import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { run } from '@myco/cli/detect-providers';

describe('myco detect-providers', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLog: typeof console.log;
  let logged: string[];
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    logged = [];
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
    originalApiKey = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('detects Ollama with models when available', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({
          models: [{ name: 'gpt-oss:latest' }, { name: 'bge-m3:latest' }],
        }));
      }
      throw new Error('Connection refused');
    }) as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;

    await run([]);

    const result = JSON.parse(logged[0]);
    expect(result.ollama.available).toBe(true);
    expect(result.ollama.models).toEqual(['gpt-oss:latest', 'bge-m3:latest']);
    expect(result['lm-studio'].available).toBe(false);
    expect(result.anthropic.available).toBe(false);
  });

  it('detects LM Studio with models when available', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('1234')) {
        return new Response(JSON.stringify({
          data: [{ id: 'deepseek-r1' }, { id: 'qwen2.5-coder' }],
        }));
      }
      throw new Error('Connection refused');
    }) as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;

    await run([]);

    const result = JSON.parse(logged[0]);
    expect(result['lm-studio'].available).toBe(true);
    expect(result['lm-studio'].models).toEqual(['deepseek-r1', 'qwen2.5-coder']);
    expect(result.ollama.available).toBe(false);
  });

  it('detects Anthropic when API key is set', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as typeof fetch;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    await run([]);

    const result = JSON.parse(logged[0]);
    expect(result.anthropic.available).toBe(true);
    expect(result.anthropic.models).toEqual([]);
  });

  it('handles all providers unavailable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;

    await run([]);

    const result = JSON.parse(logged[0]);
    expect(result.ollama.available).toBe(false);
    expect(result.ollama.models).toEqual([]);
    expect(result['lm-studio'].available).toBe(false);
    expect(result['lm-studio'].models).toEqual([]);
    expect(result.anthropic.available).toBe(false);
    expect(result.anthropic.models).toEqual([]);
  });

  it('handles all providers available simultaneously', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }));
      }
      if (urlStr.includes('1234')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-oss' }] }));
      }
      throw new Error('Unknown URL');
    }) as typeof fetch;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    await run([]);

    const result = JSON.parse(logged[0]);
    expect(result.ollama.available).toBe(true);
    expect(result.ollama.models).toEqual(['llama3']);
    expect(result['lm-studio'].available).toBe(true);
    expect(result['lm-studio'].models).toEqual(['gpt-oss']);
    expect(result.anthropic.available).toBe(true);
  });

  it('handles fetch timeout gracefully', async () => {
    globalThis.fetch = vi.fn(async () => {
      // Simulate a timeout by throwing an AbortError
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    }) as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;

    await run([]);

    const result = JSON.parse(logged[0]);
    expect(result.ollama.available).toBe(false);
    expect(result['lm-studio'].available).toBe(false);
  });

  it('outputs valid JSON to stdout', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;

    await run([]);

    // Should not throw on parse
    const result = JSON.parse(logged[0]);
    expect(result).toHaveProperty('ollama');
    expect(result).toHaveProperty('lm-studio');
    expect(result).toHaveProperty('anthropic');
  });
});
