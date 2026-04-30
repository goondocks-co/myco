import { describe, expect, it } from 'bun:test';
import {
  draftToNormalizedProviderConfig,
  normalizeSelectableModel,
  providerDraftFromSource,
} from '../../packages/myco/ui/src/hooks/use-provider-config-draft';

describe('provider config draft helpers', () => {
  it('preserves the inherited harness when defaults provide a provider bundle', () => {
    const draft = providerDraftFromSource(
      null,
      {
        harness: 'openai-agents',
        providerType: 'openrouter',
        model: 'openrouter/auto',
        reasoningMap: {
          low: 'openrouter/auto',
          default: 'openrouter/auto',
          high: 'openrouter/auto',
        },
      },
    );

    expect(draft.harness).toBe('openai-agents');
    expect(draft.type).toBe('openrouter');
    expect(draft.model).toBe('openrouter/auto');
  });

  it('does not inherit cross-provider reasoning models when a task provider override exists', () => {
    const draft = providerDraftFromSource(
      {
        harness: 'openai-agents',
        provider: {
          type: 'openai',
          model: 'gpt-5.4-nano',
        },
      },
      {
        providerType: 'openrouter',
        model: 'openrouter/auto',
        reasoningMap: {
          low: 'openrouter/auto',
          default: 'openrouter/auto',
          high: 'openrouter/auto',
        },
      },
    );

    expect(draft.reasoningLow).toBe('');
    expect(draft.reasoningDefault).toBe('gpt-5.4-nano');
    expect(draft.reasoningHigh).toBe('');
  });

  it('drops stale reasoning selections that do not belong to the active provider model list', () => {
    expect(normalizeSelectableModel('openrouter/auto', ['gpt-5.4', 'gpt-5.4-nano'])).toBe('');
    expect(normalizeSelectableModel('gpt-5.4-nano', ['gpt-5.4', 'gpt-5.4-nano'])).toBe('gpt-5.4-nano');
  });

  it('normalizes a compound provider bundle before save', () => {
    const provider = draftToNormalizedProviderConfig(
      {
        harness: 'openai-agents',
        type: 'openai',
        model: 'gpt-5.4-nano',
        reasoningLow: 'openrouter/auto',
        reasoningDefault: 'gpt-5.4-nano',
        reasoningHigh: '',
        baseUrl: '',
        contextLength: '',
      },
      ['gpt-5.4', 'gpt-5.4-nano'],
    );

    expect(provider).toEqual({
      type: 'openai',
      model: 'gpt-5.4-nano',
      reasoning_map: {
        default: 'gpt-5.4-nano',
      },
    });
  });
});
