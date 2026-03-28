import { describe, it, expect } from 'vitest';
import { vscodeCopilotAdapter } from '../../src/symbionts/vscode-copilot.js';

/** Build a JSONL string from an array of objects. */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

describe('vscodeCopilotAdapter', () => {
  it('has correct adapter metadata', () => {
    expect(vscodeCopilotAdapter.name).toBe('vscode-copilot');
    expect(vscodeCopilotAdapter.displayName).toBe('VS Code Copilot');
    expect(vscodeCopilotAdapter.pluginRootEnvVar).toBe('VSCODE_PLUGIN_ROOT');
    expect(vscodeCopilotAdapter.hookFields.sessionId).toBe('sessionId');
  });

  it('findTranscript always returns null', () => {
    expect(vscodeCopilotAdapter.findTranscript('any-session-id')).toBeNull();
  });

  describe('parseTurns — Claude Code format (type field)', () => {
    it('parses JSONL with type field for roles', () => {
      const content = toJsonl([
        {
          type: 'user',
          timestamp: '2026-03-28T10:00:00Z',
          message: { content: [{ type: 'text', text: 'Claude-format prompt' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-03-28T10:00:01Z',
          message: {
            content: [
              { type: 'text', text: 'Claude-format response' },
              { type: 'tool_use', name: 'Read', id: 't1' },
            ],
          },
        },
      ]);

      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Claude-format prompt');
      expect(turns[0].aiResponse).toBe('Claude-format response');
      expect(turns[0].toolCount).toBe(1);
      expect(turns[0].timestamp).toBe('2026-03-28T10:00:00Z');
    });
  });

  describe('parseTurns — Cursor format (role field)', () => {
    it('falls back to role field when type field produces no results', () => {
      const content = toJsonl([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Role-format prompt' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Role-format response' },
              { type: 'tool_use', name: 'Edit', id: 't1' },
              { type: 'tool_use', name: 'Write', id: 't2' },
            ],
          },
        },
      ]);

      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Role-format prompt');
      expect(turns[0].aiResponse).toBe('Role-format response');
      expect(turns[0].toolCount).toBe(2);
    });
  });

  describe('parseTurns — edge cases', () => {
    it('returns empty array for empty content', () => {
      expect(vscodeCopilotAdapter.parseTurns('')).toHaveLength(0);
    });

    it('returns empty array for unparseable content', () => {
      expect(vscodeCopilotAdapter.parseTurns('not json at all')).toHaveLength(0);
    });

    it('handles multiple turns in Claude Code format', () => {
      const content = toJsonl([
        {
          type: 'user',
          timestamp: '2026-03-28T10:00:00Z',
          message: { content: [{ type: 'text', text: 'Turn one' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-03-28T10:00:01Z',
          message: { content: [{ type: 'text', text: 'Response one' }] },
        },
        {
          type: 'user',
          timestamp: '2026-03-28T10:01:00Z',
          message: { content: [{ type: 'text', text: 'Turn two' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-03-28T10:01:01Z',
          message: { content: [{ type: 'text', text: 'Response two' }] },
        },
      ]);

      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('Turn one');
      expect(turns[1].prompt).toBe('Turn two');
    });
  });
});
