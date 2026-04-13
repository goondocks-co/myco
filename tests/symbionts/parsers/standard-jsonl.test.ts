import { describe, it, expect } from 'vitest';
import { StandardJsonlParser } from '../../../src/symbionts/parsers/standard-jsonl.js';

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
  });
});
