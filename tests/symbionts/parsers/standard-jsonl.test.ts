import { describe, it, expect } from 'bun:test';
import { StandardJsonlParser } from '@myco/symbionts/parsers/standard-jsonl.js';

/**
 * Build a JSONL string from an array of entry objects.
 */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('StandardJsonlParser', () => {
  describe('Claude Code JSONL (type-based roles)', () => {
    const parser = new StandardJsonlParser({
      roleField: 'type',
      extractTimestamp: true,
      skipToolResultUsers: true,
      stripImageTextRefs: true,
    });

    it('parses user-assistant turn pairs', () => {
      const content = toJsonl([
        { type: 'system', content: 'init', timestamp: '2026-03-15T10:00:00Z' },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Fix the bug' }] },
          timestamp: '2026-03-15T10:01:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'I found the issue.' }] },
          timestamp: '2026-03-15T10:01:30Z',
        },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Ship it' }] },
          timestamp: '2026-03-15T10:02:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done.' }] },
          timestamp: '2026-03-15T10:02:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('Fix the bug');
      expect(turns[0].aiResponse).toBe('I found the issue.');
      expect(turns[0].timestamp).toBe('2026-03-15T10:01:00Z');
      expect(turns[1].prompt).toBe('Ship it');
      expect(turns[1].aiResponse).toBe('Done.');
    });

    it('counts tool_use blocks in assistant messages', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Read the file' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
              { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
              { type: 'text', text: 'Here is the content.' },
            ],
          },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(2);
      expect(turns[0].aiResponse).toBe('Here is the content.');
    });

    it('skips tool_result user messages when skipToolResultUsers is true', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Fix the bug' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo.ts' } },
            ],
          },
          timestamp: '2026-03-15T10:00:10Z',
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'file contents here' },
            ],
          },
          timestamp: '2026-03-15T10:00:11Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Fixed the null check.' }] },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Fix the bug');
      expect(turns[0].toolCount).toBe(1);
      expect(turns[0].aiResponse).toBe('Fixed the null check.');
    });

    it('strips image text references when configured', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: {
            content: [
              { type: 'text', text: '[Image: source: /tmp/screenshot.png]\nFix this layout' },
            ],
          },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Fixed.' }] },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Fix this layout');
    });

    it('skips isMeta user messages', () => {
      const content = toJsonl([
        {
          type: 'user',
          isMeta: true,
          message: { content: [{ type: 'text', text: 'System injection' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Real prompt' }] },
          timestamp: '2026-03-15T10:01:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Ok' }] },
          timestamp: '2026-03-15T10:01:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
    });

    it('extracts images from user messages', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'What is this?' },
              {
                type: 'image',
                source: { type: 'base64', data: 'abc123', media_type: 'image/png' },
              },
            ],
          },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'A screenshot.' }] },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].images).toHaveLength(1);
      expect(turns[0].images![0].data).toBe('abc123');
      expect(turns[0].images![0].mediaType).toBe('image/png');
    });
  });

  describe('Cursor JSONL (role-based fields)', () => {
    const parser = new StandardJsonlParser({
      roleField: 'role',
      extractTimestamp: false,
      skipToolResultUsers: false,
      stripImageTextRefs: false,
    });

    it('parses role-based JSONL format', () => {
      const content = toJsonl([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Refactor this' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
              { type: 'text', text: 'Done refactoring.' },
            ],
          },
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Refactor this');
      expect(turns[0].toolCount).toBe(1);
      expect(turns[0].aiResponse).toBe('Done refactoring.');
      expect(turns[0].timestamp).toBe('');
    });

    it('does not skip tool_result user messages when skipToolResultUsers is false', () => {
      // With skipToolResultUsers: false, a user message without text still gets skipped
      // because hasText is checked unconditionally — but if a user message has text, it starts a new turn
      const content = toJsonl([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'First prompt' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            ],
          },
        },
        {
          role: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'file data' },
            ],
          },
        },
        {
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Here you go.' }] },
        },
      ]);

      const turns = parser.parseTurns(content);

      // tool_result has no text block, so it's skipped regardless
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('First prompt');
      expect(turns[0].toolCount).toBe(1);
      expect(turns[0].aiResponse).toBe('Here you go.');
    });
  });

  describe('edge cases', () => {
    const parser = new StandardJsonlParser({
      roleField: 'type',
      extractTimestamp: true,
      skipToolResultUsers: true,
      stripImageTextRefs: false,
    });

    it('handles empty content', () => {
      expect(parser.parseTurns('')).toEqual([]);
    });

    it('handles invalid JSON lines gracefully', () => {
      const content = 'not json\n{"type":"user","message":{"content":[{"type":"text","text":"Hello"}]},"timestamp":"2026-01-01T00:00:00Z"}\n{broken\n';

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Hello');
    });

    it('handles turn without AI response (trailing user)', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Do something' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Do something');
      expect(turns[0].aiResponse).toBeUndefined();
    });

    it('accumulates tool counts across multiple assistant messages', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Do many things' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            ],
          },
          timestamp: '2026-03-15T10:00:10Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
              { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
              { type: 'text', text: 'All done.' },
            ],
          },
          timestamp: '2026-03-15T10:00:20Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(3);
      expect(turns[0].aiResponse).toBe('All done.');
    });

    // Surfaced 2026-05-28 via live dogfood smoke: Claude Code v2.1.x emits
    // real user prompts as `message.content: string` (and tool_result entries
    // as the array form). Pre-fix, the parser only inspected array content,
    // so every real user prompt was skipped and the parser returned zero
    // turns — the entire transcript-mining path (populateBatchResponses,
    // skill detection, plan-tag extraction) silently no-op'd. The prompt-kind
    // walker already handled both forms via extractText; this mirrors that.
    it('handles message.content as a plain string (Claude Code v2.1.x format)', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { role: 'user', content: 'fix the bug in foo.ts' },
          timestamp: '2026-05-28T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done.' }] },
          timestamp: '2026-05-28T10:00:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('fix the bug in foo.ts');
      expect(turns[0].aiResponse).toBe('Done.');
    });

    // Surfaced 2026-05-28 via live dogfood smoke: a multi-block assistant turn
    // (text → tool_use → text → tool_use → text → …) emits one JSONL entry per
    // text/tool boundary, so the parser walks several entries that each carry
    // a text fragment. The pre-fix `current.aiResponse = text` overwrote with
    // each new entry, leaving only the trailing fragment in response_summary.
    // The Sessions UI then surfaced "Test in flight…" — an interim status —
    // as the apparent response to a turn that actually ended with a full
    // implementation summary. Asserts the parser concatenates every text
    // fragment with a blank-line separator so the full turn round-trips.
    it('concatenates text fragments across alternating text/tool assistant entries', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Multi-step task' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'First thought.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
          timestamp: '2026-03-15T10:00:10Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Second thought.' }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
          timestamp: '2026-03-15T10:00:20Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Final answer.' }] },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(2);
      expect(turns[0].aiResponse).toBe('First thought.\n\nSecond thought.\n\nFinal answer.');
    });

    // Surfaced 2026-05-28 via live capture audit: Claude Code's Esc→queue
    // prompts arrive as `attachment` / `attachment.type: queued_command`
    // entries (no UserPromptSubmit, no role:user message). The prompt-kind
    // walker captures them as steering batches via the queued_command shape,
    // but this parser — which drives response attribution — ignored attachment
    // entries entirely, so the assistant text after a queued prompt globbed
    // onto the PRECEDING turn and the steering batch got a NULL response.
    // The parser must open a new turn on the queued_command, keyed on the same
    // `attachment.prompt` the walker uses, so populateBatchResponses can
    // prefix-match the response onto the steering batch.
    it('treats queued_command attachments as turn boundaries so the response attaches to the queued prompt', () => {
      const content = toJsonl([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'initial request' }] },
          timestamp: '2026-05-28T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
          timestamp: '2026-05-28T10:00:05Z',
        },
        // Queued mid-turn steering prompt — attachment entry, not role:user.
        {
          type: 'attachment',
          attachment: { type: 'queued_command', prompt: 'actually also handle the edge case' },
          uuid: 'queued-1',
          timestamp: '2026-05-28T10:00:10Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'edge case handled' }] },
          timestamp: '2026-05-28T10:00:20Z',
        },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(2);
      // Initial turn keeps only its own pre-queue response.
      expect(turns[0].prompt).toBe('initial request');
      expect(turns[0].aiResponse).toBe('working on it');
      // Queued prompt opens its own turn and claims the response that follows it.
      expect(turns[1].prompt).toBe('actually also handle the edge case');
      expect(turns[1].aiResponse).toBe('edge case handled');
    });

    // Image-bearing queued prompts carry attachment.prompt as a typed-block
    // ARRAY ([{type:text},{type:image}]), not a string. The walker handles both
    // (so the batch exists); the parser must too or the image-bearing queued
    // prompt gets no turn and no response attribution.
    it('handles queued_command attachment.prompt as a typed-block array (image-bearing queued prompt)', () => {
      const content = toJsonl([
        { type: 'user', message: { content: [{ type: 'text', text: 'first' }] }, timestamp: '2026-05-28T10:00:00Z' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] }, timestamp: '2026-05-28T10:00:05Z' },
        {
          type: 'attachment', uuid: 'q-img',
          attachment: {
            type: 'queued_command',
            prompt: [
              { type: 'text', text: 'look at this screenshot [Image #1]' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
          timestamp: '2026-05-28T10:00:10Z',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'analyzed the screenshot' }] }, timestamp: '2026-05-28T10:00:20Z' },
      ]);

      const turns = parser.parseTurns(content);

      expect(turns).toHaveLength(2);
      expect(turns[1].prompt).toBe('look at this screenshot [Image #1]');
      expect(turns[1].aiResponse).toBe('analyzed the screenshot');
      expect(turns[1].images).toHaveLength(1);
      expect(turns[1].images![0].data).toBe('AAAA');
    });

    it('ignores non-queued attachment entries (no spurious turn)', () => {
      const content = toJsonl([
        { type: 'user', message: { content: [{ type: 'text', text: 'req' }] }, timestamp: '2026-05-28T10:00:00Z' },
        { type: 'attachment', attachment: { type: 'image', prompt: 'should-not-appear' }, timestamp: '2026-05-28T10:00:05Z' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-05-28T10:00:10Z' },
      ]);
      const turns = parser.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('req');
      expect(turns[0].aiResponse).toBe('done');
    });
  });
});
