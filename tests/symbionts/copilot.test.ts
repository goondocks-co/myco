import { describe, it, expect } from 'bun:test';
import { copilotAdapter } from '@myco/symbionts/copilot.js';
import {
  buildCopilotSourcedUserMessageTranscript,
  COPILOT_SOURCED_USER_MESSAGE_PROMPT,
  COPILOT_SOURCED_USER_MESSAGE_RESPONSE,
} from '../helpers/copilot-transcript.js';

/**
 * Build a Copilot event-log JSONL transcript string.
 *
 * The schema mirrors what `copilot-agent` v0.49+ (and the VS Code Copilot
 * extension after the unified-agent-experience rework) writes to disk:
 *   { id, parentId, timestamp, type, data }
 * one event per line, chronological order.
 */
function buildCopilotTranscript(
  turns: Array<{
    prompt: string;
    timestamp?: string;
    assistantText?: string;
    toolCalls?: Array<{ toolName: string; success?: boolean }>;
  }>,
): string {
  const lines: string[] = [];
  let id = 0;
  const nextId = () => `evt-${id++}`;

  lines.push(JSON.stringify({
    id: nextId(),
    type: 'session.start',
    timestamp: '2026-05-23T18:00:00.000Z',
    data: { sessionId: 'test-session', version: 1, producer: 'copilot-agent' },
  }));

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnId = String(i);
    const ts = turn.timestamp ?? `2026-05-23T18:0${i}:00.000Z`;

    lines.push(JSON.stringify({
      id: nextId(),
      timestamp: ts,
      type: 'user.message',
      data: { content: turn.prompt, attachments: [] },
    }));
    lines.push(JSON.stringify({
      id: nextId(),
      timestamp: ts,
      type: 'assistant.turn_start',
      data: { turnId },
    }));

    for (const tool of turn.toolCalls ?? []) {
      const toolCallId = `call-${nextId()}`;
      lines.push(JSON.stringify({
        id: nextId(),
        timestamp: ts,
        type: 'tool.execution_start',
        data: { toolCallId, toolName: tool.toolName, arguments: {} },
      }));
      lines.push(JSON.stringify({
        id: nextId(),
        timestamp: ts,
        type: 'tool.execution_complete',
        data: { toolCallId, success: tool.success ?? true },
      }));
    }

    if (turn.assistantText) {
      lines.push(JSON.stringify({
        id: nextId(),
        timestamp: ts,
        type: 'assistant.message',
        data: { messageId: `msg-${i}`, content: turn.assistantText, toolRequests: [] },
      }));
    }

    lines.push(JSON.stringify({
      id: nextId(),
      timestamp: ts,
      type: 'assistant.turn_end',
      data: { turnId },
    }));
  }

  return lines.join('\n');
}

describe('copilotAdapter', () => {
  it('has correct adapter metadata', () => {
    expect(copilotAdapter.name).toBe('copilot');
    expect(copilotAdapter.displayName).toBe('GitHub Copilot');
    expect(copilotAdapter.pluginRootEnvVar).toBe('COPILOT_PLUGIN_ROOT');
    expect(copilotAdapter.hookFields.sessionId).toBe('session_id');
  });

  it('findTranscript always returns null', () => {
    expect(copilotAdapter.findTranscript('any-session-id')).toBeNull();
  });

  describe('parseTurns — event-log format', () => {
    it('parses a single user prompt', () => {
      const content = buildCopilotTranscript([
        { prompt: 'Do a full code review' },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Do a full code review');
    });

    it('extracts assistant response from assistant.message content', () => {
      const content = buildCopilotTranscript([
        { prompt: 'Review the code', assistantText: 'Here is my analysis of the code.' },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].aiResponse).toBe('Here is my analysis of the code.');
    });

    it('concatenates multiple assistant.message events within one turn', () => {
      // Real Copilot transcripts often emit several assistant.message events
      // per turn (one before each tool block, one for the final answer).
      const content = buildCopilotTranscript([
        {
          prompt: 'Trace the bug',
          toolCalls: [{ toolName: 'read' }],
          assistantText: 'I traced the bug to file X and confirmed the root cause.',
        },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].aiResponse).toContain('I traced the bug');
    });

    it('counts tool.execution_start events as toolCount', () => {
      const content = buildCopilotTranscript([
        {
          prompt: 'Fix the bug',
          toolCalls: [
            { toolName: 'read' },
            { toolName: 'edit' },
            { toolName: 'execute' },
          ],
          assistantText: 'Fixed.',
        },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(3);
      expect(turns[0].aiResponse).toBe('Fixed.');
    });

    it('handles multiple user turns in a single transcript', () => {
      const content = buildCopilotTranscript([
        { prompt: 'First question', assistantText: 'First answer.' },
        { prompt: 'Second question', toolCalls: [{ toolName: 'read' }] },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('First question');
      expect(turns[0].aiResponse).toBe('First answer.');
      expect(turns[1].prompt).toBe('Second question');
      expect(turns[1].toolCount).toBe(1);
    });

    it('keeps sourced user.message records inside the active human turn', () => {
      const content = buildCopilotSourcedUserMessageTranscript('test-session');

      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe(COPILOT_SOURCED_USER_MESSAGE_PROMPT);
      expect(turns[0].toolCount).toBe(1);
      expect(turns[0].aiResponse).toBe(COPILOT_SOURCED_USER_MESSAGE_RESPONSE);
    });

    it('attributes tool calls to the in-flight user turn', () => {
      // Tool events between user.message events should accumulate on the
      // most recent turn — not bleed into the next prompt.
      const content = buildCopilotTranscript([
        { prompt: 'First', toolCalls: [{ toolName: 'a' }, { toolName: 'b' }] },
        { prompt: 'Second', toolCalls: [{ toolName: 'c' }] },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns[0].toolCount).toBe(2);
      expect(turns[1].toolCount).toBe(1);
    });

    it('preserves the user.message timestamp on the turn', () => {
      const content = buildCopilotTranscript([
        { prompt: 'Test', timestamp: '2026-05-23T18:42:00.123Z' },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns[0].timestamp).toBe('2026-05-23T18:42:00.123Z');
    });
  });

  describe('edge cases', () => {
    it('returns empty for empty content', () => {
      expect(copilotAdapter.parseTurns('')).toHaveLength(0);
    });

    it('returns empty for non-JSON content', () => {
      expect(copilotAdapter.parseTurns('not json')).toHaveLength(0);
    });

    it('skips malformed lines without aborting the parse', () => {
      const valid = buildCopilotTranscript([
        { prompt: 'Real prompt', assistantText: 'Real answer.' },
      ]).split('\n');
      // Inject a garbage line in the middle.
      const content = [valid[0], '{not valid json}', ...valid.slice(1)].join('\n');
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
      expect(turns[0].aiResponse).toBe('Real answer.');
    });

    it('skips user.message events with empty content', () => {
      const content = buildCopilotTranscript([
        { prompt: '' },
        { prompt: 'Real prompt' },
      ]);
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
    });

    it('ignores stray tool.execution_start events before any user.message', () => {
      const content = [
        JSON.stringify({ id: 'a', type: 'session.start', timestamp: 'x', data: {} }),
        JSON.stringify({ id: 'b', type: 'tool.execution_start', timestamp: 'x', data: { toolCallId: 't1', toolName: 'orphan' } }),
      ].join('\n');
      const turns = copilotAdapter.parseTurns(content);
      expect(turns).toHaveLength(0);
    });
  });
});
