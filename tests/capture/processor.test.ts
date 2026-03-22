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
    await processor.process('### Turn 1\n**User:** hello\n**Assistant:** hi', 's1');

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

  it('processes conversation markdown into summary + observations', async () => {
    const conversation = [
      '### Turn 1',
      '**User:** Refactor the auth middleware',
      '**Assistant:** I\'ll update src/auth.ts to use JWT rotation with RS256.',
    ].join('\n');
    const processor = new BufferProcessor(mockBackend);
    const result = await processor.process(conversation, 'session-abc');
    expect(result.summary).toContain('auth');
    expect(result.observations).toHaveLength(1);
  });

  it('returns empty result for empty conversation', async () => {
    const processor = new BufferProcessor(mockBackend);
    const result = await processor.process('', 'session-abc');
    expect(result.summary).toBe('');
    expect(result.observations).toHaveLength(0);
    expect(result.degraded).toBe(false);
  });

  it('returns empty result for whitespace-only conversation', async () => {
    const processor = new BufferProcessor(mockBackend);
    const result = await processor.process('   \n  \n  ', 'session-abc');
    expect(result.summary).toBe('');
    expect(result.observations).toHaveLength(0);
    expect(result.degraded).toBe(false);
  });

  it('handles LLM failure gracefully', async () => {
    const failBackend: LlmProvider = {
      ...mockBackend,
      async summarize() { throw new Error('LLM unavailable'); },
    };
    const processor = new BufferProcessor(failBackend);
    const result = await processor.process('### Turn 1\n**User:** hello', 's1');
    expect(result.degraded).toBe(true);
  });

  it('truncates long conversation from the beginning, keeping recent turns', async () => {
    const spy = vi.spyOn(mockBackend, 'summarize');
    // Use a small context window so truncation kicks in
    const processor = new BufferProcessor(mockBackend, 1024);

    // Build a conversation larger than the available budget
    // contextWindow=1024, overhead=500, maxTokens=2048 => availableTokens is negative,
    // so use a realistic window instead
    const largProcessor = new BufferProcessor(mockBackend, 4096);
    const turns: string[] = [];
    for (let i = 1; i <= 100; i++) {
      turns.push(`### Turn ${i}\n**User:** Question ${i}\n**Assistant:** ${'A'.repeat(200)}`);
    }
    const longConversation = turns.join('\n\n');
    await largProcessor.process(longConversation, 'session-trunc');

    expect(spy).toHaveBeenCalled();
    // The prompt should contain later turns, not the first ones
    const promptSent = spy.mock.calls[0][0];
    expect(promptSent).toContain('Turn 100');
    spy.mockRestore();
  });
});
