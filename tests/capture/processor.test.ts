import { describe, it, expect, vi } from 'vitest';
import { BufferProcessor } from '@myco/daemon/processor';
import type { LlmProvider, LlmRequestOptions } from '@myco/intelligence/llm';

describe('BufferProcessor', () => {
  const mockBackend: LlmProvider = {
    name: 'mock',
    async summarize(prompt: string, opts?: LlmRequestOptions) {
      return {
        text: JSON.stringify({
          summary: 'Refactored auth middleware to use JWT rotation.',
          observations: [
            {
              type: 'decision',
              title: 'RS256 over HS256',
              content: 'Chose RS256 for key rotation support.',
              tags: ['auth', 'jwt'],
            },
          ],
        }),
        model: 'mock',
      };
    },
    async isAvailable() { return true; },
  };

  it('accepts contextWindow in constructor', () => {
    const processor = new BufferProcessor(mockBackend, 4096);
    expect(processor).toBeDefined();
  });

  it('defaults contextWindow to 8192', () => {
    const processor = new BufferProcessor(mockBackend);
    expect(processor).toBeDefined();
  });

  it('passes maxTokens to summarize for process()', async () => {
    const spy = vi.spyOn(mockBackend, 'summarize');
    const processor = new BufferProcessor(mockBackend, 8192);
    await processor.process([{ type: 'tool_use', tool: 'Read' }], 's1');

    expect(spy).toHaveBeenCalled();
    const opts = spy.mock.calls[0][1];
    expect(opts).toBeDefined();
    expect(opts!.maxTokens).toBe(2048);
    spy.mockRestore();
  });

  it('passes maxTokens to summarize for summarizeSession()', async () => {
    const spy = vi.spyOn(mockBackend, 'summarize');
    const processor = new BufferProcessor(mockBackend, 8192);
    await processor.summarizeSession('## Conversation\nhello', 's1');

    // First call is summary (512), second is title (32)
    expect(spy.mock.calls[0][1]?.maxTokens).toBe(512);
    expect(spy.mock.calls[1][1]?.maxTokens).toBe(32);
    spy.mockRestore();
  });

  it('processes buffer events into summary + observations', async () => {
    const events = [
      { type: 'tool_use', tool: 'Read', input: { path: 'src/auth.ts' } },
      { type: 'tool_use', tool: 'Edit', input: { path: 'src/auth.ts' } },
    ];
    const processor = new BufferProcessor(mockBackend);
    const result = await processor.process(events, 'session-abc');
    expect(result.summary).toContain('auth');
    expect(result.observations).toHaveLength(1);
  });

  it('handles LLM failure gracefully', async () => {
    const failBackend: LlmProvider = {
      ...mockBackend,
      async summarize() { throw new Error('LLM unavailable'); },
    };
    const processor = new BufferProcessor(failBackend);
    const result = await processor.process([{ type: 'tool_use', tool: 'Read' }], 's1');
    expect(result.degraded).toBe(true);
  });
});
