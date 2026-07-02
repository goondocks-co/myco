import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REASONING_LEVEL,
  resolveReasoningModel,
  resolveThinkingConfig,
  resolveModelSettings,
} from './reasoning-levels.js';
import type { ProviderConfig } from './types.js';

describe('resolveThinkingConfig', () => {
  test('maps low to a fixed small budget by default', () => {
    expect(resolveThinkingConfig('low', undefined)).toEqual({
      type: 'enabled',
      budgetTokens: 1024,
    });
  });

  test('maps default to adaptive thinking by default', () => {
    expect(resolveThinkingConfig('default', undefined)).toEqual({ type: 'adaptive' });
  });

  test('maps high to a large fixed budget by default', () => {
    expect(resolveThinkingConfig('high', undefined)).toEqual({
      type: 'enabled',
      budgetTokens: 32000,
    });
  });

  test('undefined reasoningLevel falls back to the default tier mapping', () => {
    expect(resolveThinkingConfig(undefined, undefined)).toEqual({ type: 'adaptive' });
  });

  test('forces disabled for local providers regardless of tier', () => {
    const ollama: ProviderConfig = { type: 'ollama' };
    expect(resolveThinkingConfig('high', ollama)).toEqual({ type: 'disabled' });
    expect(resolveThinkingConfig('low', ollama)).toEqual({ type: 'disabled' });
  });

  test('provider thinkingBudgetMap overrides the default for a specific tier', () => {
    const anthropic: ProviderConfig = {
      type: 'anthropic',
      thinkingBudgetMap: { low: { budgetTokens: 2048 } },
    };
    expect(resolveThinkingConfig('low', anthropic)).toEqual({
      type: 'enabled',
      budgetTokens: 2048,
    });
    // Unset tier still falls back to the built-in default.
    expect(resolveThinkingConfig('high', anthropic)).toEqual({
      type: 'enabled',
      budgetTokens: 32000,
    });
  });

  test('provider thinkingBudgetMap can override a tier to adaptive', () => {
    const anthropic: ProviderConfig = {
      type: 'anthropic',
      thinkingBudgetMap: { low: { adaptive: true } },
    };
    expect(resolveThinkingConfig('low', anthropic)).toEqual({ type: 'adaptive' });
  });
});

describe('resolveModelSettings', () => {
  test('maps each tier to effort + verbosity by default', () => {
    expect(resolveModelSettings('low', undefined)).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
    expect(resolveModelSettings('default', undefined)).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'medium' },
    });
    expect(resolveModelSettings('high', undefined)).toEqual({
      reasoning: { effort: 'high' },
      text: { verbosity: 'high' },
    });
  });

  test('undefined reasoningLevel falls back to the default tier mapping', () => {
    expect(resolveModelSettings(undefined, undefined)).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'medium' },
    });
  });

  test('returns undefined for local providers', () => {
    const lmstudio: ProviderConfig = { type: 'lmstudio' };
    expect(resolveModelSettings('high', lmstudio)).toBeUndefined();
    const ollama: ProviderConfig = { type: 'ollama' };
    expect(resolveModelSettings('low', ollama)).toBeUndefined();
    const openaiCompatible: ProviderConfig = { type: 'openai-compatible' };
    expect(resolveModelSettings('default', openaiCompatible)).toBeUndefined();
  });

  test('provider effortMap overrides the default for a specific tier', () => {
    const openai: ProviderConfig = {
      type: 'openai',
      effortMap: { high: { effort: 'xhigh', verbosity: 'high' } },
    };
    expect(resolveModelSettings('high', openai)).toEqual({
      reasoning: { effort: 'xhigh' },
      text: { verbosity: 'high' },
    });
    // Unset tier still falls back to the built-in default.
    expect(resolveModelSettings('low', openai)).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
  });
});

describe('resolveReasoningModel (unchanged, regression guard)', () => {
  test('still resolves to a model string via reasoningMap', () => {
    const provider: ProviderConfig = {
      type: 'anthropic',
      reasoningMap: { low: 'claude-haiku-4-6' },
    };
    expect(resolveReasoningModel('low', provider, 'claude-sonnet-4-6')).toBe('claude-haiku-4-6');
  });

  test('DEFAULT_REASONING_LEVEL is still default', () => {
    expect(DEFAULT_REASONING_LEVEL).toBe('default');
  });
});
