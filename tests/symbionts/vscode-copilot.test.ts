import { describe, it, expect } from 'vitest';
import { vscodeCopilotAdapter } from '../../src/symbionts/vscode-copilot.js';

/** Build a VS Code delta JSONL string. */
function buildVsCodeTranscript(
  requests: Array<{
    text: string;
    timestamp?: number;
    responseParts?: Array<Record<string, unknown>>;
  }>,
): string {
  const initial = {
    kind: 0,
    v: {
      version: 3,
      sessionId: 'test-session',
      requests: requests.map((r) => ({
        requestId: `req-${Math.random()}`,
        timestamp: r.timestamp ?? Date.now(),
        message: { text: r.text, parts: [] },
        response: r.responseParts
          ? Object.fromEntries(r.responseParts.map((p, i) => [String(i), p]))
          : {},
      })),
    },
  };
  return JSON.stringify(initial);
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

  describe('parseTurns — delta JSONL format', () => {
    it('parses user prompt from initial state', () => {
      const content = buildVsCodeTranscript([
        { text: 'Do a full code review' },
      ]);
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Do a full code review');
    });

    it('extracts AI response from markdownContent parts', () => {
      const content = buildVsCodeTranscript([
        {
          text: 'Review the code',
          responseParts: [
            { kind: 'thinking', value: 'Planning...' },
            { kind: 'markdownContent', content: { value: 'Here is my analysis of the code.' } },
          ],
        },
      ]);
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].aiResponse).toBe('Here is my analysis of the code.');
    });

    it('counts tool invocations', () => {
      const content = buildVsCodeTranscript([
        {
          text: 'Fix the bug',
          responseParts: [
            { kind: 'toolInvocationSerialized', invocationMessage: { value: 'Reading file...' } },
            { kind: 'toolInvocationSerialized', invocationMessage: { value: 'Running tests...' } },
            { kind: 'markdownContent', content: { value: 'Fixed.' } },
          ],
        },
      ]);
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(2);
      expect(turns[0].aiResponse).toBe('Fixed.');
    });

    it('handles multiple requests', () => {
      const content = buildVsCodeTranscript([
        { text: 'First question' },
        { text: 'Second question' },
      ]);
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('First question');
      expect(turns[1].prompt).toBe('Second question');
    });

    it('handles deltas that add requests', () => {
      // Initial state has one request, then a kind:2 delta adds another
      const lines = [
        JSON.stringify({
          kind: 0,
          v: {
            sessionId: 'test',
            requests: [{ message: { text: 'First prompt' }, response: {} }],
          },
        }),
        JSON.stringify({
          kind: 2,
          k: ['requests'],
          v: { message: { text: 'Second prompt via delta' }, response: {}, timestamp: Date.now() },
        }),
      ];
      const content = lines.join('\n');
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('First prompt');
      expect(turns[1].prompt).toBe('Second prompt via delta');
    });

    it('handles kind:2 response part deltas', () => {
      // Initial state has empty response, deltas append parts
      const lines = [
        JSON.stringify({
          kind: 0,
          v: {
            sessionId: 'test',
            requests: [{ message: { text: 'Test prompt' }, response: {}, timestamp: Date.now() }],
          },
        }),
        JSON.stringify({
          kind: 2,
          k: ['requests', '0', 'response'],
          v: [{ kind: 'thinking', value: 'Planning...' }],
        }),
        JSON.stringify({
          kind: 2,
          k: ['requests', '0', 'response'],
          v: [{ kind: 'toolInvocationSerialized', invocationMessage: { value: 'Reading...' } }],
        }),
        JSON.stringify({
          kind: 2,
          k: ['requests', '0', 'response'],
          v: [{ value: 'The code looks good overall.' }],
        }),
      ];
      const content = lines.join('\n');
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(1);
      // Plain text part (no kind) should be captured as AI response
      expect(turns[0].aiResponse).toContain('The code looks good');
    });

    it('extracts timestamp from request', () => {
      const content = buildVsCodeTranscript([
        { text: 'Test', timestamp: 1774726974511 },
      ]);
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns[0].timestamp).toBeTruthy();
    });
  });

  describe('edge cases', () => {
    it('returns empty for empty content', () => {
      expect(vscodeCopilotAdapter.parseTurns('')).toHaveLength(0);
    });

    it('returns empty for non-delta format', () => {
      expect(vscodeCopilotAdapter.parseTurns('not json')).toHaveLength(0);
    });

    it('returns empty when kind:0 is missing', () => {
      const content = JSON.stringify({ kind: 1, k: ['foo'], v: 'bar' });
      expect(vscodeCopilotAdapter.parseTurns(content)).toHaveLength(0);
    });

    it('skips requests with empty prompt', () => {
      const content = buildVsCodeTranscript([
        { text: '' },
        { text: 'Real prompt' },
      ]);
      const turns = vscodeCopilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
    });
  });
});
