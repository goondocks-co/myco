import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { getCostProvider, resolveCost } from '@myco/agent/cost/index.js';
import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[OPENROUTER_API_KEY_ENV];
});

describe('resolveCost', () => {
  it('returns the correct resolver for known provider types', () => {
    const openRouterProvider = getCostProvider({
      harness: 'openai-agents',
      model: 'openrouter/auto',
      provider: { type: 'openrouter', model: 'openrouter/auto' },
      usage: {},
    });
    const localProvider = getCostProvider({
      harness: 'claude-sdk',
      model: 'llama3.2',
      provider: { type: 'ollama', model: 'llama3.2' },
      usage: {},
    });

    expect(openRouterProvider?.id).toBe('openrouter');
    expect(localProvider?.id).toBe('generic-configured');
  });

  it('prefers actual cost reported by the runtime', async () => {
    const result = await resolveCost({
      harness: 'claude-sdk',
      model: 'claude-sonnet-4-6',
      provider: { type: 'anthropic', model: 'claude-sonnet-4-6' },
      usage: {
        inputTokens: 1_500,
        outputTokens: 350,
        totalTokens: 1_850,
        costUsd: 0.0042,
      },
    });

    expect(result.source).toBe('actual');
    expect(result.costUsd).toBe(0.0042);
    expect(result.actualCostUsd).toBe(0.0042);
    expect(result.estimatedCostUsd).toBeNull();
  });

  it('estimates OpenAI pricing with cached-input discounts', async () => {
    const result = await resolveCost({
      harness: 'openai-agents',
      model: 'gpt-5.4-nano',
      provider: { type: 'openai', model: 'gpt-5.4-nano' },
      usage: {
        inputTokens: 165_021,
        cachedTokens: 111_104,
        outputTokens: 453,
        totalTokens: 165_474,
      },
    });

    expect(result.source).toBe('estimated');
    expect(result.costUsd).toBeCloseTo(0.01357173);
    expect(result.breakdown.cachedInputTokens).toBe(111_104);
    expect(result.breakdown.uncachedInputTokens).toBe(53_917);
    expect(result.breakdown.cacheSavingsUsd).toBeCloseTo(0.01999872);
  });

  it('estimates OpenRouter pricing from the live model catalog', async () => {
    process.env[OPENROUTER_API_KEY_ENV] = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'openai/gpt-5.4-mini',
          pricing: {
            prompt: '0.00000075',
            input_cache_read: '0.000000075',
            completion: '0.0000045',
            request: '0',
          },
        }],
      }),
    })));

    const result = await resolveCost({
      harness: 'openai-agents',
      model: 'openai/gpt-5.4-mini',
      provider: { type: 'openrouter', model: 'openai/gpt-5.4-mini' },
      usage: {
        requests: 2,
        inputTokens: 2_000,
        cachedTokens: 500,
        outputTokens: 300,
      },
    });

    expect(result.source).toBe('estimated');
    expect(result.costUsd).toBeCloseTo(0.0025125);
    expect(result.breakdown.inputCostUsd).toBeCloseTo(0.001125);
    expect(result.breakdown.cachedInputCostUsd).toBeCloseTo(0.0000375);
    expect(result.breakdown.outputCostUsd).toBeCloseTo(0.00135);
  });

  it('treats negative OpenRouter catalog rates as unavailable pricing', async () => {
    process.env[OPENROUTER_API_KEY_ENV] = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'openrouter/auto',
          pricing: {
            prompt: '-1',
            completion: '-1',
          },
        }],
      }),
    })));

    const result = await resolveCost({
      harness: 'openai-agents',
      model: 'openrouter/auto',
      provider: { type: 'openrouter', model: 'openrouter/auto' },
      usage: {
        requests: 1,
        inputTokens: 2_000,
        outputTokens: 300,
      },
    });

    expect(result.source).toBe('unavailable');
    expect(result.costUsd).toBeNull();
    expect(result.estimatedCostUsd).toBeNull();
  });
});
