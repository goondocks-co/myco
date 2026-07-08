import { describe, expect, test } from 'bun:test';
import { MycoConfigSchema } from '@myco/config/schema.js';

describe('ProviderOverrideSchema (via MycoConfigSchema.agent.provider)', () => {
  test('keeps thinking_budget_map and effort_map (Zod v4 default-strips unknown keys otherwise)', () => {
    const parsed = MycoConfigSchema.parse({
      version: 3,
      agent: {
        provider: {
          type: 'anthropic',
          thinking_budget_map: { low: { budgetTokens: 2048 } },
          effort_map: { high: { effort: 'xhigh', verbosity: 'high' } },
        },
      },
    });
    expect(parsed.agent.provider?.thinking_budget_map).toEqual({ low: { budgetTokens: 2048 } });
    expect(parsed.agent.provider?.effort_map).toEqual({ high: { effort: 'xhigh', verbosity: 'high' } });
  });

  test('omitting thinking_budget_map/effort_map is not an error and leaves them undefined', () => {
    const parsed = MycoConfigSchema.parse({
      version: 3,
      agent: {
        provider: {
          type: 'anthropic',
          reasoning_map: { low: 'claude-haiku-4-6' },
        },
      },
    });
    expect(parsed.agent.provider?.reasoning_map).toEqual({ low: 'claude-haiku-4-6' });
    expect(parsed.agent.provider?.thinking_budget_map).toBeUndefined();
    expect(parsed.agent.provider?.effort_map).toBeUndefined();
  });

  test('budgetTokens must be positive integer (rejects negative values)', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      agent: {
        provider: {
          type: 'anthropic',
          thinking_budget_map: { low: { budgetTokens: -50 } },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test('budgetTokens must be positive integer (rejects floating-point values)', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      agent: {
        provider: {
          type: 'anthropic',
          thinking_budget_map: { default: { budgetTokens: 1.5 } },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test('budgetTokens below the Anthropic API minimum (1024) is rejected', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      agent: {
        provider: {
          type: 'anthropic',
          thinking_budget_map: { low: { budgetTokens: 512 } },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test('budgetTokens at the Anthropic API minimum (1024) is accepted', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      agent: {
        provider: {
          type: 'anthropic',
          thinking_budget_map: { low: { budgetTokens: 1024 } },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
