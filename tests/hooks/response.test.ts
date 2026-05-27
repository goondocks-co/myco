import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { writeHookResponse } from '@myco/hooks/response.js';

describe('writeHookResponse (manifest-driven)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  describe('cursor (declares format: json)', () => {
    it('emits {} for an empty response (valid JSON — avoids the "invalid JSON" failure)', () => {
      writeHookResponse('cursor', 'stop');
      expect(captured).toBe('{}');
      expect(() => JSON.parse(captured)).not.toThrow();
    });

    it('renames HookResponse fields to cursor\'s wire names from the manifest', () => {
      writeHookResponse('cursor', 'session-start', { additionalContext: 'hello world' });
      expect(JSON.parse(captured)).toEqual({ additional_context: 'hello world' });
    });

    it('serializes every declared HookResponse field', () => {
      writeHookResponse('cursor', 'subagent-stop', {
        additionalContext: 'ctx',
        continue: false,
        stopReason: 'because',
        userMessage: 'u',
        followupMessage: 'f',
        systemMessage: 's',
      });
      expect(JSON.parse(captured)).toEqual({
        additional_context: 'ctx',
        continue: false,
        stop_reason: 'because',
        user_message: 'u',
        followup_message: 'f',
        system_message: 's',
      });
    });

    it('omits fields the manifest doesn\'t map', () => {
      writeHookResponse('cursor', 'stop', { additionalContext: 'ok' });
      const body = JSON.parse(captured);
      expect(body).toHaveProperty('additional_context', 'ok');
      for (const key of Object.keys(body)) {
        expect(key).not.toMatch(/[A-Z]/);
      }
    });
  });

  describe('claude-code / codex / windsurf hook response shapes', () => {
    it('emits UserPromptSubmit additionalContext as plain text for Claude Code', () => {
      writeHookResponse('claude-code', 'user-prompt-submit', { additionalContext: 'inject this' });
      expect(captured).toBe('inject this');
    });

    it('emits Claude Code PreToolUse context in hookSpecificOutput JSON', () => {
      writeHookResponse('claude-code', 'pre-tool-use', { additionalContext: 'inject this' });
      expect(JSON.parse(captured)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: 'inject this',
        },
      });
    });

    it('emits nothing when the response has no additionalContext', () => {
      writeHookResponse('claude-code', 'stop');
      expect(captured).toBe('');
    });

    it('emits empty stdout (not `{}`) for pre-tool-use with no additionalContext', () => {
      writeHookResponse('claude-code', 'pre-tool-use');
      expect(captured).toBe('');
    });

    it('ignores non-context fields in plain-text mode', () => {
      writeHookResponse('claude-code', 'subagent-stop', {
        additionalContext: 'ctx',
        followupMessage: 'ignored here',
      });
      expect(captured).toBe('ctx');
    });
  });

  describe('pre-tool-use envelope is capability-driven', () => {
    it('codex pre-tool-use emits the hookSpecificOutput envelope (preToolUseInjection enabled)', () => {
      writeHookResponse('codex', 'pre-tool-use', { additionalContext: 'BLOB' });
      expect(JSON.parse(captured)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: 'BLOB',
        },
      });
    });

    it('cursor pre-tool-use does not emit the envelope (no preToolUseInjection capability)', () => {
      writeHookResponse('cursor', 'pre-tool-use', { additionalContext: 'BLOB' });
      expect(captured).not.toContain('hookSpecificOutput');
    });
  });

  describe('subagent-start envelope is capability-driven', () => {
    it('Claude Code emits SubagentStart context in hookSpecificOutput JSON', () => {
      writeHookResponse('claude-code', 'subagent-start', { additionalContext: 'myco primer' });
      expect(JSON.parse(captured)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'myco primer',
        },
      });
    });

    it('Codex emits SubagentStart context in hookSpecificOutput JSON', () => {
      writeHookResponse('codex', 'subagent-start', { additionalContext: 'myco primer' });
      expect(JSON.parse(captured)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'myco primer',
        },
      });
    });

    it('Copilot emits subagent additionalContext at the top level', () => {
      writeHookResponse('copilot', 'subagent-start', { additionalContext: 'myco primer' });
      expect(JSON.parse(captured)).toEqual({ additionalContext: 'myco primer' });
    });

    it('unsupported symbionts do not get the SubagentStart envelope', () => {
      writeHookResponse('cursor', 'subagent-start', { additionalContext: 'myco primer' });
      expect(captured).toBe('');
    });
  });

  describe('unknown symbiont', () => {
    it('falls back to the plain-text default rather than crashing', () => {
      writeHookResponse('some-hypothetical-agent', 'stop', { additionalContext: 'ok' });
      expect(captured).toBe('ok');
    });

    it('handles an undefined symbiont too (no crash, plain-text)', () => {
      writeHookResponse(undefined, 'stop');
      expect(captured).toBe('');
    });
  });

  describe('antigravity inject-steps response', () => {
    it('renders multiple additionalSteps as separate injectSteps entries', () => {
      writeHookResponse('antigravity', 'session-start', {
        additionalSteps: ['<cortex>cortex text</cortex>', '<spores>spore text</spores>'],
      });
      const parsed = JSON.parse(captured) as { injectSteps: Array<{ userMessage: string }> };
      expect(parsed.injectSteps).toHaveLength(2);
      expect(parsed.injectSteps[0].userMessage).toBe('<cortex>cortex text</cortex>');
      expect(parsed.injectSteps[1].userMessage).toBe('<spores>spore text</spores>');
    });

    it('drops empty entries from additionalSteps so an empty cortex+full spores yields ONE step', () => {
      writeHookResponse('antigravity', 'session-start', {
        additionalSteps: ['', 'spore text only'],
      });
      const parsed = JSON.parse(captured) as { injectSteps: Array<{ userMessage: string }> };
      expect(parsed.injectSteps).toHaveLength(1);
      expect(parsed.injectSteps[0].userMessage).toBe('spore text only');
    });

    it('falls back to legacy additionalContext as one injectStep when additionalSteps is absent', () => {
      writeHookResponse('antigravity', 'session-start', { additionalContext: 'just one block' });
      const parsed = JSON.parse(captured) as { injectSteps: Array<{ userMessage: string }> };
      expect(parsed.injectSteps).toHaveLength(1);
      expect(parsed.injectSteps[0].userMessage).toBe('just one block');
    });

    it('emits `{}` when there is nothing to inject', () => {
      writeHookResponse('antigravity', 'session-start', {});
      expect(captured).toBe('{}');
    });

    it('emits `{}` when additionalSteps is empty after filtering', () => {
      writeHookResponse('antigravity', 'session-start', { additionalSteps: ['', ''] });
      expect(captured).toBe('{}');
    });

    it('Stop is unaffected — still returns the decision envelope', () => {
      writeHookResponse('antigravity', 'stop', { additionalSteps: ['ignored', 'for stop'] });
      expect(JSON.parse(captured)).toEqual({ decision: 'allow' });
    });
  });

  describe('plain-text additionalSteps fallback', () => {
    it('joins additionalSteps with a blank line for plain-text symbionts', () => {
      writeHookResponse('claude-code', 'user-prompt-submit', {
        additionalSteps: ['block one', 'block two'],
      });
      expect(captured).toBe('block one\n\nblock two');
    });

    it('falls back to additionalContext when additionalSteps is empty', () => {
      writeHookResponse('claude-code', 'user-prompt-submit', { additionalContext: 'legacy block' });
      expect(captured).toBe('legacy block');
    });
  });
});
