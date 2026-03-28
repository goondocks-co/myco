import { describe, it, expect } from 'vitest';
import { windsurfAdapter } from '../../src/symbionts/windsurf.js';

/** Build a JSONL string from an array of objects. */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

describe('windsurfAdapter', () => {
  it('has correct adapter metadata', () => {
    expect(windsurfAdapter.name).toBe('windsurf');
    expect(windsurfAdapter.displayName).toBe('Windsurf');
    expect(windsurfAdapter.pluginRootEnvVar).toBe('WINDSURF_PLUGIN_ROOT');
    expect(windsurfAdapter.hookFields.sessionId).toBe('trajectory_id');
  });

  describe('parseTurns', () => {
    it('parses user_input and planner_response entries', () => {
      const content = toJsonl([
        { type: 'user_input', user_response: 'Fix the login bug' },
        { type: 'planner_response', response: 'I will fix the login handler.' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Fix the login bug');
      expect(turns[0].aiResponse).toBe('I will fix the login handler.');
      expect(turns[0].toolCount).toBe(0);
    });

    it('counts code_action entries as tool uses', () => {
      const content = toJsonl([
        { type: 'user_input', text: 'Refactor utils' },
        { type: 'planner_response', response: 'Refactoring now.' },
        { type: 'code_action', file_path: 'src/utils.ts', status: 'complete' },
        { type: 'code_action', file_path: 'src/helpers.ts', status: 'complete' },
        { type: 'code_action', file_path: 'tests/utils.test.ts', status: 'complete' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(3);
    });

    it('handles multiple conversation turns', () => {
      const content = toJsonl([
        { type: 'user_input', user_response: 'First task' },
        { type: 'planner_response', response: 'Working on it.' },
        { type: 'code_action', file_path: 'a.ts' },
        { type: 'user_input', content: 'Second task' },
        { type: 'planner_response', text: 'Done with second.' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('First task');
      expect(turns[0].aiResponse).toBe('Working on it.');
      expect(turns[0].toolCount).toBe(1);
      expect(turns[1].prompt).toBe('Second task');
      expect(turns[1].aiResponse).toBe('Done with second.');
      expect(turns[1].toolCount).toBe(0);
    });

    it('extracts prompt from text field fallback', () => {
      const content = toJsonl([
        { type: 'user_input', text: 'From text field' },
        { type: 'planner_response', content: 'Response from content field' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('From text field');
      expect(turns[0].aiResponse).toBe('Response from content field');
    });

    it('extracts prompt from content field fallback', () => {
      const content = toJsonl([
        { type: 'user_input', content: 'From content field' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('From content field');
    });

    it('skips planner_response and code_action before first user_input', () => {
      const content = toJsonl([
        { type: 'planner_response', response: 'Orphaned response' },
        { type: 'code_action', file_path: 'orphan.ts' },
        { type: 'user_input', user_response: 'Real prompt' },
        { type: 'planner_response', response: 'Real response' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Real prompt');
      expect(turns[0].toolCount).toBe(0);
    });

    it('returns empty array for empty content', () => {
      expect(windsurfAdapter.parseTurns('')).toHaveLength(0);
    });

    it('skips malformed JSON lines', () => {
      const content = '{ broken\n' + JSON.stringify({
        type: 'user_input',
        user_response: 'Valid entry',
      });

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Valid entry');
    });

    it('handles empty prompt fields gracefully', () => {
      const content = toJsonl([
        { type: 'user_input' },
        { type: 'planner_response', response: 'Response to empty prompt' },
      ]);

      const turns = windsurfAdapter.parseTurns(content);
      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('');
      expect(turns[0].aiResponse).toBe('Response to empty prompt');
    });
  });
});
