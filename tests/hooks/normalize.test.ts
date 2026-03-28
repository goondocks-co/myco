import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeHookInput, _resetManifestCache } from '../../src/hooks/normalize.js';

// Mock loadManifests to avoid file system access during tests
vi.mock('../../src/symbionts/detect.js', () => ({
  loadManifests: vi.fn().mockReturnValue([]),
}));

import { loadManifests } from '../../src/symbionts/detect.js';

const mockLoadManifests = vi.mocked(loadManifests);

describe('normalizeHookInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetManifestCache();
    delete process.env.MYCO_SESSION_ID;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.GEMINI_SESSION_ID;
    delete process.env.WINDSURF_PLUGIN_ROOT;
  });

  afterEach(() => {
    delete process.env.MYCO_SESSION_ID;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.GEMINI_SESSION_ID;
    delete process.env.WINDSURF_PLUGIN_ROOT;
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

    it('generates a session ID when none provided', () => {
      mockLoadManifests.mockReturnValue([]);
      const result = normalizeHookInput({});
      expect(result.sessionId).toMatch(/^s-\d+$/);
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

    it('maps trajectory_id to sessionId for Windsurf', () => {
      mockLoadManifests.mockReturnValue([windsurfManifest]);
      process.env.WINDSURF_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({ trajectory_id: 'traj-42', prompt: 'test' });
      expect(result.sessionId).toBe('traj-42');
      expect(result.prompt).toBe('test');
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

    it('maps VS Code camelCase sessionId', () => {
      const vsCodeManifest = {
        name: 'vscode-copilot',
        displayName: 'VS Code Copilot',
        binary: 'code',
        configDir: '.vscode',
        pluginRootEnvVar: 'VSCODE_PLUGIN_ROOT',
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
      mockLoadManifests.mockReturnValue([vsCodeManifest]);
      process.env.VSCODE_PLUGIN_ROOT = '/some/path';
      const result = normalizeHookInput({ sessionId: 'vsc-session-1' });
      expect(result.sessionId).toBe('vsc-session-1');
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
});
