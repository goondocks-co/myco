import { describe, it, expect, vi } from 'vitest';
import { BufferProcessor } from '@myco/daemon/processor';
import type { LlmProvider, LlmRequestOptions } from '@myco/intelligence/llm';

function mockBackend(response: string): LlmProvider {
  return {
    name: 'mock',
    summarize: async (_prompt: string, _opts?: LlmRequestOptions) => ({ text: response, model: 'mock' }),
    isAvailable: async () => true,
  };
}

function failingBackend(): LlmProvider {
  return {
    name: 'mock',
    summarize: async () => { throw new Error('LLM unavailable'); },
    isAvailable: async () => false,
  };
}

describe('classifyArtifacts', () => {
  it('parses valid classification response', async () => {
    const backend = mockBackend(JSON.stringify({
      artifacts: [{
        source_path: 'docs/spec.md',
        artifact_type: 'spec',
        title: 'Design Spec',
        tags: ['auth'],
      }],
    }));
    const processor = new BufferProcessor(backend);
    const result = await processor.classifyArtifacts(
      [{ path: 'docs/spec.md', content: '# Spec' }], 'test-session',
    );
    expect(result).toHaveLength(1);
    expect(result[0].artifact_type).toBe('spec');
  });

  it('passes maxTokens 1024 to summarize', async () => {
    const backend = mockBackend('{"artifacts": []}');
    const spy = vi.spyOn(backend, 'summarize');
    const processor = new BufferProcessor(backend);
    await processor.classifyArtifacts(
      [{ path: 'docs/spec.md', content: '# Spec' }], 'test-session',
    );
    expect(spy.mock.calls[0][1]?.maxTokens).toBe(1024);
  });

  it('returns empty array for empty candidates', async () => {
    const backend = mockBackend('should not be called');
    const processor = new BufferProcessor(backend);
    const result = await processor.classifyArtifacts([], 'test-session');
    expect(result).toHaveLength(0);
  });

  it('throws on LLM failure', async () => {
    const processor = new BufferProcessor(failingBackend());
    await expect(
      processor.classifyArtifacts([{ path: 'docs/spec.md', content: '# Spec' }], 'test-session'),
    ).rejects.toThrow('LLM unavailable');
  });

  it('throws on malformed JSON', async () => {
    const backend = mockBackend('not valid json {{{');
    const processor = new BufferProcessor(backend);
    await expect(
      processor.classifyArtifacts([{ path: 'docs/spec.md', content: '# Spec' }], 'test-session'),
    ).rejects.toThrow();
  });
});
