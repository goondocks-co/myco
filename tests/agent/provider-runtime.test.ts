import { describe, expect, it } from 'bun:test';
import { inferRuntimeFromProviderType } from '@myco/agent/provider-runtime.js';

describe('inferRuntimeFromProviderType', () => {
  it('maps Claude-shaped providers to the Claude runtime', () => {
    expect(inferRuntimeFromProviderType('anthropic')).toBe('claude-sdk');
    expect(inferRuntimeFromProviderType('ollama')).toBe('claude-sdk');
    expect(inferRuntimeFromProviderType('lmstudio')).toBe('claude-sdk');
  });

  it('maps OpenAI-shaped providers to the OpenAI runtime', () => {
    expect(inferRuntimeFromProviderType('openai')).toBe('openai-agents');
    expect(inferRuntimeFromProviderType('openrouter')).toBe('openai-agents');
    expect(inferRuntimeFromProviderType('openai-compatible')).toBe('openai-agents');
  });
});
