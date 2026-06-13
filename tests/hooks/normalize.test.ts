import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { normalizeHookInput, readSymbiontFlag, _resetManifestCache } from '@myco/hooks/normalize.js';

// Mock loadManifests to avoid file system access during tests
mock.module('@myco/symbionts/detect.js', () => ({
  loadManifests: vi.fn().mockReturnValue([]),
}));

import { loadManifests } from '@myco/symbionts/detect.js';

const mockLoadManifests = vi.mocked(loadManifests);

describe('normalizeHookInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetManifestCache();
    delete process.env.MYCO_SESSION_ID;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.GEMINI_SESSION_ID;
    delete process.env.WINDSURF_PLUGIN_ROOT;
    delete process.env.CURSOR_PLUGIN_ROOT;
  });

  afterEach(() => {
    delete process.env.MYCO_SESSION_ID;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.GEMINI_SESSION_ID;
    delete process.env.WINDSURF_PLUGIN_ROOT;
    delete process.env.CURSOR_PLUGIN_ROOT;
  });

  describe('default mapping (no agent detected)', () => {
    it('maps session_id from Claude Code format', () => {
      mockLoadManifests.mockReturnValue([]);
      const result = normalizeHookInput({ session_id: 'abc123', prompt: 'hello' });
      expect(result.sessionId).toBe('abc123');
      expect(result.prompt).toBe('hello');
    });

    it('maps transcript_path and last_assistant_message', () => {
      mockLoadManifests.mockReturnValue([]);
      const result = normalizeHookInput({
        session_id: 's1',
        transcript_path: '/path/to/transcript',
        last_assistant_message: 'response text',
      });
      expect(result.transcriptPath).toBe('/path/to/transcript');
      expect(result.lastResponse).toBe('response text');
    });

    it('maps tool fields', () => {
      mockLoadManifests.mockReturnValue([]);
      const result = normalizeHookInput({
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_output: 'file.txt',
      });
      expect(result.toolName).toBe('Bash');
      expect(result.toolInput).toEqual({ command: 'ls' });
      expect(result.toolOutput).toBe('file.txt');
    });

    it('preserves raw input', () => {
      mockLoadManifests.mockReturnValue([]);
      const raw = { session_id: 's1', custom_field: 'value' };
      const result = normalizeHookInput(raw);
      expect(result.raw).toBe(raw);
      expect(result.raw.custom_field).toBe('value');
    });
  });

  describe('session ID fallbacks', () => {
    it('falls back to MYCO_SESSION_ID env var', () => {
      mockLoadManifests.mockReturnValue([]);
      process.env.MYCO_SESSION_ID = 'env-session';
      const result = normalizeHookInput({});
      expect(result.sessionId).toBe('env-session');
    });

    it('leaves sessionId undefined when none is provided', () => {
      mockLoadManifests.mockReturnValue([]);
      const result = normalizeHookInput({});
      expect(result.sessionId).toBeUndefined();
    });

    it('prefers input over env var', () => {
      mockLoadManifests.mockReturnValue([]);
      process.env.MYCO_SESSION_ID = 'env-session';
      const result = normalizeHookInput({ session_id: 'input-session' });
      expect(result.sessionId).toBe('input-session');
    });
  });

  describe('manifest-driven mapping', () => {
    const windsurfManifest = {
      name: 'windsurf',
      displayName: 'Windsurf',
      binary: 'windsurf',
      configDir: '.windsurf',
      pluginRootEnvVar: 'WINDSURF_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'trajectory_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };

    const cursorManifest = {
      name: 'cursor',
      displayName: 'Cursor',
      binary: 'cursor',
      configDir: '.cursor',
      pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'conversation_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };

    it('maps trajectory_id to sessionId for Windsurf', () => {
      mockLoadManifests.mockReturnValue([windsurfManifest]);
      process.env.WINDSURF_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({ trajectory_id: 'traj-42', prompt: 'test' });
      expect(result.sessionId).toBe('traj-42');
      expect(result.prompt).toBe('test');
    });

    it('does not fabricate a sessionId for a known symbiont with an empty payload', () => {
      mockLoadManifests.mockReturnValue([windsurfManifest]);
      process.env.WINDSURF_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({ prompt: 'test' });
      expect(result.agent).toBe('windsurf');
      expect(result.sessionId).toBeUndefined();
    });

    it('derives Cursor sessionId from transcript_path when conversation_id is missing', () => {
      mockLoadManifests.mockReturnValue([cursorManifest]);
      process.env.CURSOR_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({
        transcript_path: '/Users/chris/.Cursor/projects/Users-chris-Repos-myco/agent-transcripts/94f4087c-1121-463e-bc1b-9d5248e48d27/94f4087c-1121-463e-bc1b-9d5248e48d27.jsonl',
      });
      expect(result.agent).toBe('cursor');
      expect(result.sessionId).toBe('94f4087c-1121-463e-bc1b-9d5248e48d27');
    });

    it('does not derive a Cursor sessionId from an unsupported transcript path', () => {
      mockLoadManifests.mockReturnValue([cursorManifest]);
      process.env.CURSOR_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({
        transcript_path: '/tmp/not-a-cursor-transcript.jsonl',
      });
      expect(result.agent).toBe('cursor');
      expect(result.sessionId).toBeUndefined();
    });

    it('uses sessionIdEnv for Gemini', () => {
      const geminiManifest = {
        name: 'gemini',
        displayName: 'Gemini CLI',
        binary: 'gemini',
        configDir: '.gemini',
        pluginRootEnvVar: 'GEMINI_PLUGIN_ROOT',
        hookFields: {
          sessionId: 'session_id',
          transcriptPath: 'transcript_path',
          lastResponse: 'last_assistant_message',
          prompt: 'prompt',
          toolName: 'tool_name',
          toolInput: 'tool_input',
          toolOutput: 'tool_output',
          sessionIdEnv: 'GEMINI_SESSION_ID',
        },
      };
      mockLoadManifests.mockReturnValue([geminiManifest]);
      process.env.GEMINI_SESSION_ID = 'gemini-sess-123';
      // No session_id in input, no GEMINI_PLUGIN_ROOT — detect via sessionIdEnv
      const result = normalizeHookInput({});
      expect(result.sessionId).toBe('gemini-sess-123');
    });

    it('prefers input sessionId over sessionIdEnv', () => {
      const geminiManifest = {
        name: 'gemini',
        displayName: 'Gemini CLI',
        binary: 'gemini',
        configDir: '.gemini',
        pluginRootEnvVar: 'GEMINI_PLUGIN_ROOT',
        hookFields: {
          sessionId: 'session_id',
          transcriptPath: 'transcript_path',
          lastResponse: 'last_assistant_message',
          prompt: 'prompt',
          toolName: 'tool_name',
          toolInput: 'tool_input',
          toolOutput: 'tool_output',
          sessionIdEnv: 'GEMINI_SESSION_ID',
        },
      };
      mockLoadManifests.mockReturnValue([geminiManifest]);
      process.env.GEMINI_SESSION_ID = 'env-sid';
      const result = normalizeHookInput({ session_id: 'input-sid' });
      expect(result.sessionId).toBe('input-sid');
    });

    it('maps Copilot camelCase sessionId', () => {
      const copilotManifest = {
        name: 'copilot',
        displayName: 'GitHub Copilot',
        binary: 'copilot',
        configDir: '.vscode',
        pluginRootEnvVar: 'COPILOT_PLUGIN_ROOT',
        hookFields: {
          sessionId: 'sessionId',
          transcriptPath: 'transcript_path',
          lastResponse: 'last_assistant_message',
          prompt: 'prompt',
          toolName: 'tool_name',
          toolInput: 'tool_input',
          toolOutput: 'tool_output',
        },
      };
      mockLoadManifests.mockReturnValue([copilotManifest]);
      process.env.COPILOT_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({ sessionId: 'copilot-session-1' });
      expect(result.sessionId).toBe('copilot-session-1');
    });
  });

  describe('nested field resolution', () => {
    it('resolves dot-notation paths', () => {
      const manifest = {
        name: 'nested-agent',
        displayName: 'Nested Agent',
        binary: 'nested',
        configDir: '.nested',
        pluginRootEnvVar: 'NESTED_PLUGIN_ROOT',
        hookFields: {
          sessionId: 'session_id',
          transcriptPath: 'tool_info.transcript_path',
          lastResponse: 'tool_info.response',
          prompt: 'prompt',
          toolName: 'tool_info.name',
          toolInput: 'tool_info.input',
          toolOutput: 'tool_info.output',
        },
      };
      mockLoadManifests.mockReturnValue([manifest]);
      process.env.NESTED_PLUGIN_ROOT = '/some/path';

      const result = normalizeHookInput({
        session_id: 's1',
        tool_info: {
          transcript_path: '/nested/path',
          response: 'nested response',
          name: 'NestedTool',
          input: { x: 1 },
          output: 'done',
        },
      });

      expect(result.transcriptPath).toBe('/nested/path');
      expect(result.lastResponse).toBe('nested response');
      expect(result.toolName).toBe('NestedTool');
      expect(result.toolInput).toEqual({ x: 1 });
      expect(result.toolOutput).toBe('done');
    });

    it('returns undefined for missing nested paths', () => {
      mockLoadManifests.mockReturnValue([]);
      const result = normalizeHookInput({ session_id: 's1' });
      expect(result.transcriptPath).toBeUndefined();
      expect(result.toolName).toBeUndefined();
      expect(result.toolInput).toBeUndefined();
    });
  });

  describe('caching', () => {
    it('caches manifest detection across calls', () => {
      mockLoadManifests.mockReturnValue([]);
      normalizeHookInput({ session_id: 's1' });
      normalizeHookInput({ session_id: 's2' });
      // loadManifests should only be called once (cached after first call)
      expect(mockLoadManifests).toHaveBeenCalledTimes(1);
    });
  });

  describe('readSymbiontFlag (pure argv parser)', () => {
    it('reads --symbiont <name>', () => {
      expect(readSymbiontFlag(['hook', 'session-start', '--symbiont', 'codex'])).toBe('codex');
    });

    it('reads --symbiont=<name> joined form', () => {
      expect(readSymbiontFlag(['hook', 'session-start', '--symbiont=codex'])).toBe('codex');
    });

    it('returns undefined when no flag is present', () => {
      expect(readSymbiontFlag(['hook', 'session-start'])).toBeUndefined();
    });

    it('returns undefined when --symbiont is dangling (no value)', () => {
      expect(readSymbiontFlag(['hook', 'session-start', '--symbiont'])).toBeUndefined();
    });

    it('returns undefined when --symbiont is followed by another flag', () => {
      expect(readSymbiontFlag(['--symbiont', '--debug'])).toBeUndefined();
    });

    it('finds the flag regardless of position in argv', () => {
      expect(readSymbiontFlag(['--symbiont', 'windsurf', 'hook', 'stop'])).toBe('windsurf');
    });
  });

  describe('argv-driven detection (--symbiont flag)', () => {
    const originalArgv = process.argv;

    const codexManifest = {
      name: 'codex',
      displayName: 'Codex',
      binary: 'codex',
      configDir: '.codex',
      pluginRootEnvVar: 'CODEX_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };
    const claudeManifest = {
      name: 'claude-code',
      displayName: 'Claude Code',
      binary: 'claude',
      configDir: '.claude',
      pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };
    const cursorManifest = {
      name: 'cursor',
      displayName: 'Cursor',
      binary: 'cursor',
      configDir: '.cursor',
      pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
      hookFields: {
        sessionId: ['conversation_id', 'session_id'],
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('uses --symbiont codex from argv as the primary signal', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.argv = ['node', 'myco-run', 'hook', 'session-start', '--symbiont', 'codex'];
      const result = normalizeHookInput({ session_id: 'abc' });
      expect(result.agent).toBe('codex');
    });

    it('argv flag wins over a misleading CLAUDE_PLUGIN_ROOT env var', () => {
      // Regression guard: the installer owns agent identity; runtime env
      // must not override the explicit installer declaration.
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.env.CLAUDE_PLUGIN_ROOT = '/fake/claude/plugin';
      process.argv = ['node', 'myco-run', 'hook', 'session-start', '--symbiont', 'codex'];
      const result = normalizeHookInput({ session_id: 'abc' });
      expect(result.agent).toBe('codex');
    });

    it('argv flag wins over a transcript_path that looks like claude', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.argv = ['node', 'myco-run', 'hook', 'session-start', '--symbiont', 'codex'];
      const result = normalizeHookInput({
        session_id: 'abc',
        transcript_path: '/Users/me/.claude/projects/foo/abc.jsonl',
      });
      expect(result.agent).toBe('codex');
    });

    it('uses Cursor argv attribution while accepting embedded Claude-style session_id payloads', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, cursorManifest]);
      process.argv = ['node', 'myco-run', 'hook', 'post-tool-use', '--symbiont', 'cursor'];
      const result = normalizeHookInput({
        session_id: 'cursor-embedded-runtime-session',
        transcript_path: '/Users/me/.claude/projects/foo/cursor-embedded-runtime-session.jsonl',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/file.ts' },
      });
      expect(result.agent).toBe('cursor');
      expect(result.sessionId).toBe('cursor-embedded-runtime-session');
      expect(result.toolName).toBe('Read');
      expect(result.toolInput).toEqual({ file_path: '/repo/src/file.ts' });
    });

    it('prefers the primary field when a manifest declares ordered aliases', () => {
      mockLoadManifests.mockReturnValue([cursorManifest]);
      process.argv = ['node', 'myco-run', 'hook', 'post-tool-use', '--symbiont', 'cursor'];
      const result = normalizeHookInput({
        conversation_id: 'cursor-native-session',
        session_id: 'embedded-runtime-session',
      });
      expect(result.agent).toBe('cursor');
      expect(result.sessionId).toBe('cursor-native-session');
    });

    it('unknown --symbiont value falls through to heuristic detection', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.argv = ['node', 'myco-run', 'hook', 'session-start', '--symbiont', 'bogus'];
      // No env var, no transcript match → defaults to claude-code.
      const result = normalizeHookInput({ session_id: 'abc' });
      expect(result.agent).toBe('claude-code');
    });

    it('falls back to env var when --symbiont flag is absent', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.env.CLAUDE_PLUGIN_ROOT = '/some/path';
      process.argv = ['node', 'myco-run', 'hook', 'session-start'];
      const result = normalizeHookInput({ session_id: 'abc' });
      expect(result.agent).toBe('claude-code');
    });

    it('falls back to transcript_path heuristic when argv and env are both absent', () => {
      // Pre-flag installation safety net: a Codex session that somehow
      // skipped the update should still be correctly attributed via
      // configDir matching against the transcript_path.
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.argv = ['node', 'myco-run', 'hook', 'session-start'];
      const result = normalizeHookInput({
        session_id: 'abc',
        transcript_path: '/Users/chris/.codex/sessions/2026/04/11/rollout-abc.jsonl',
      });
      expect(result.agent).toBe('codex');
    });
  });

  describe('payload-driven detection (transcript_path → configDir, fallback)', () => {
    // These exercise the third detection strategy: when neither
    // pluginRootEnvVar nor sessionIdEnv is set, fall back to matching
    // the payload's transcript_path / cwd against each manifest's
    // configDir. This is how we attribute Codex sessions — Codex
    // doesn't set a CODEX_PLUGIN_ROOT env var, but it does send
    // transcript_path pointing into ~/.codex/sessions/.
    const codexManifest = {
      name: 'codex',
      displayName: 'Codex',
      binary: 'codex',
      configDir: '.codex',
      pluginRootEnvVar: 'CODEX_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };

    const claudeManifest = {
      name: 'claude-code',
      displayName: 'Claude Code',
      binary: 'claude',
      configDir: '.claude',
      pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
        prompt: 'prompt',
        toolName: 'tool_name',
        toolInput: 'tool_input',
        toolOutput: 'tool_output',
      },
    };

    it('detects codex from transcript_path pointing into ~/.codex/', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      const result = normalizeHookInput({
        session_id: '019d7d62',
        transcript_path: '/Users/chris/.codex/sessions/2026/04/11/rollout-019d7d62.jsonl',
        prompt: 'hi',
      });
      expect(result.agent).toBe('codex');
    });

    it('detects claude-code from transcript_path pointing into ~/.claude/', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      const result = normalizeHookInput({
        session_id: 'abc',
        transcript_path: '/Users/chris/.claude/projects/-Users-chris-Repos-foo/abc.jsonl',
        prompt: 'hi',
      });
      expect(result.agent).toBe('claude-code');
    });

    it('falls back to cwd when transcript_path is absent', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      const result = normalizeHookInput({
        session_id: 'abc',
        cwd: '/Users/chris/.codex/projects/some-repo',
        prompt: 'hi',
      });
      expect(result.agent).toBe('codex');
    });

    it('defaults to claude-code when neither env var, transcript_path, nor cwd carry a marker', () => {
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      const result = normalizeHookInput({ session_id: 'abc', prompt: 'hi' });
      // Falls through to the DEFAULT_AGENT_NAME default.
      expect(result.agent).toBe('claude-code');
    });

    it('env-var detection still wins over payload detection', () => {
      // A Claude Code session with CLAUDE_PLUGIN_ROOT set should be
      // attributed to claude-code even if some weird payload mentions
      // ".codex/" — env-var is the strongest signal.
      mockLoadManifests.mockReturnValue([claudeManifest, codexManifest]);
      process.env.CLAUDE_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({
        session_id: 'abc',
        transcript_path: '/Users/chris/.codex/sessions/x.jsonl',
      });
      expect(result.agent).toBe('claude-code');
    });
  });
});
