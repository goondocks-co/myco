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
    it('codex pre-tool-use does not emit the envelope until preToolUseInjection is enabled', () => {
      // Codex declares format: json (see hook-config). Without the
      // preToolUseInjection capability, it must fall through to the
      // manifest-driven JSON serializer — not the claude-style envelope.
      writeHookResponse('codex', 'pre-tool-use', { additionalContext: 'BLOB' });
      expect(captured).not.toContain('hookSpecificOutput');
    });

    it('cursor pre-tool-use does not emit the envelope (no preToolUseInjection capability)', () => {
      writeHookResponse('cursor', 'pre-tool-use', { additionalContext: 'BLOB' });
      expect(captured).not.toContain('hookSpecificOutput');
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
});
