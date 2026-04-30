import { describe, expect, it } from 'bun:test';
import { inferHarnessFromProviderType } from '@myco/agent/provider-harness.js';

describe('inferHarnessFromProviderType', () => {
  it('maps Claude-shaped providers to the Claude harness', () => {
    expect(inferHarnessFromProviderType('anthropic')).toBe('claude-sdk');
    expect(inferHarnessFromProviderType('ollama')).toBe('claude-sdk');
    expect(inferHarnessFromProviderType('lmstudio')).toBe('claude-sdk');
  });

  it('maps OpenAI-shaped providers to the OpenAI harness', () => {
    expect(inferHarnessFromProviderType('openai')).toBe('openai-agents');
    expect(inferHarnessFromProviderType('openrouter')).toBe('openai-agents');
    expect(inferHarnessFromProviderType('openai-compatible')).toBe('openai-agents');
  });
});
