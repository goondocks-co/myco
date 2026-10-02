import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NO_AGENT, normalizeHookInput, readSymbiontFlag, _resetManifestCache } from '@myco/hooks/normalize.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';

// Normalization reads the build-time generated hook config; mock it with a
// mutable table so each test declares exactly the symbionts it needs.
const HOOK_CONFIG: Record<string, unknown> = {};
mock.module('@myco/hooks/hook-config.generated.js', () => ({ HOOK_CONFIG }));

interface TestSymbiont {
  name: string;
  configDir: string;
  pluginRootEnvVar: string;
  hookFields: Record<string, unknown>;
}

/** Replace the mocked generated config with entries for the given symbionts. */
function setHookConfig(symbionts: TestSymbiont[]): void {
  for (const key of Object.keys(HOOK_CONFIG)) delete HOOK_CONFIG[key];
  for (const m of symbionts) {
    HOOK_CONFIG[m.name] = {
      pluginRootEnvVar: m.pluginRootEnvVar,
      configDir: m.configDir,
      hookFields: m.hookFields,
      hookEvents: {},
      planDirs: [],
      planTags: [],
      capabilities: { preToolUseInjection: false, sessionStartInjection: false, subagentStartInjection: false },
    };
  }
}

const FIELDS = {
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  lastResponse: 'last_assistant_message',
  prompt: 'prompt',
  toolName: 'tool_name',
  toolInput: 'tool_input',
  toolOutput: ['tool_output', 'tool_response'],
};
const claudeManifest = { name: 'claude-code', configDir: '.claude', pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT', hookFields: FIELDS };
const codexManifest = { name: 'codex', configDir: '.codex', pluginRootEnvVar: 'CODEX_PLUGIN_ROOT', hookFields: FIELDS };
const windsurfManifest = { name: 'windsurf', configDir: '.windsurf', pluginRootEnvVar: 'WINDSURF_PLUGIN_ROOT', hookFields: { ...FIELDS, sessionId: 'trajectory_id' } };
const geminiManifest = { name: 'gemini', configDir: '.gemini', pluginRootEnvVar: 'GEMINI_PLUGIN_ROOT', hookFields: { ...FIELDS, sessionIdEnv: 'GEMINI_SESSION_ID' } };
const cursorManifest = {
  name: 'cursor', configDir: '.cursor', pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
  hookFields: {
    ...FIELDS,
    sessionId: ['conversation_id', 'session_id'],
    // Where Cursor's own manifest says its transcript path holds the session id.
    sessionIdFromTranscriptPath: BUNDLED_MANIFESTS.find((m) => m.name === 'cursor')!.hookFields.sessionIdFromTranscriptPath,
  },
};

const ENV_SIGNALS = ['MYCO_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'GEMINI_SESSION_ID', 'WINDSURF_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT'];
const originalArgv = process.argv;
/** A hook process whose command names `harness`, or none. */
const named = (harness?: string): void => {
  process.argv = ['node', 'myco', 'hook', 'session-start', ...(harness === undefined ? [] : ['--symbiont', harness])];
};

describe('normalizeHookInput', () => {
  beforeEach(() => {
    setHookConfig([claudeManifest, codexManifest, windsurfManifest, geminiManifest, cursorManifest]);
    _resetManifestCache();
    for (const name of ENV_SIGNALS) delete process.env[name];
  });
  afterEach(() => {
    process.argv = originalArgv;
    for (const name of ENV_SIGNALS) delete process.env[name];
  });

  describe('the harness a hook runs for', () => {
    it('is the one its command names', () => {
      named('codex');
      expect(normalizeHookInput({ session_id: 'abc' }).agent).toBe('codex');
    });

    it('is no harness when the command names none, whatever else the hook carries', () => {
      // What 1.x took a harness from when the command named none: a plugin-root variable, a session-id variable, or a
      // configuration directory in the payload's paths. None of them names one now.
      process.env.CLAUDE_PLUGIN_ROOT = '/some/path';
      process.env.GEMINI_SESSION_ID = 'gemini-sess';
      named();
      const result = normalizeHookInput({ session_id: 'abc', transcript_path: '/Users/me/.codex/sessions/abc.jsonl', cwd: '/Users/me/.claude/x' });
      expect(result).toEqual({ agent: NO_AGENT, raw: result.raw });
    });

    it('is no harness when the command names one no manifest knows', () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/some/path';
      named('bogus');
      expect(normalizeHookInput({ session_id: 'abc' }).agent).toBe(NO_AGENT);
    });

    it('is kept for the process: the first answer stands', () => {
      named('windsurf');
      expect(normalizeHookInput({ trajectory_id: 's1' }).agent).toBe('windsurf');
      named('codex');
      expect(normalizeHookInput({ trajectory_id: 's2' }).agent).toBe('windsurf');
    });
  });

  describe('field mapping, from the named harness\'s manifest', () => {
    it('maps the session, transcript, response, prompt and tool fields', () => {
      named('claude-code');
      const raw = { session_id: 's1', transcript_path: '/t', last_assistant_message: 'r', prompt: 'p', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_output: 'out', custom: 'v' };
      expect(normalizeHookInput(raw)).toEqual({
        agent: 'claude-code', sessionId: 's1', transcriptPath: '/t', lastResponse: 'r', prompt: 'p', toolName: 'Bash', toolInput: { command: 'ls' }, toolOutput: 'out', raw,
      });
    });

    it('reads a structured tool result delivered under tool_response', () => {
      named('claude-code');
      expect(normalizeHookInput({ session_id: 's1', tool_response: { stdout: 'a.ts\n' } }).toolOutput).toEqual({ stdout: 'a.ts\n' });
    });

    it('maps trajectory_id to sessionId for Windsurf, and fabricates none for an empty payload', () => {
      named('windsurf');
      expect(normalizeHookInput({ trajectory_id: 'traj-42' }).sessionId).toBe('traj-42');
      _resetManifestCache();
      expect(normalizeHookInput({ prompt: 'x' })).toMatchObject({ agent: 'windsurf', sessionId: undefined });
    });

    it('prefers the primary of ordered aliases, and falls through an empty one', () => {
      named('cursor');
      expect(normalizeHookInput({ conversation_id: 'native', session_id: 'embedded' }).sessionId).toBe('native');
      expect(normalizeHookInput({ conversation_id: '', session_id: 'embedded' }).sessionId).toBe('embedded');
    });

    it('derives Cursor\'s session id from its transcript path where the payload carries none', () => {
      named('cursor');
      expect(normalizeHookInput({
        transcript_path: '/Users/chris/.Cursor/projects/Users-chris-Repos-myco/agent-transcripts/94f4087c-1121-463e-bc1b-9d5248e48d27/94f4087c-1121-463e-bc1b-9d5248e48d27.jsonl',
      }).sessionId).toBe('94f4087c-1121-463e-bc1b-9d5248e48d27');
      // The flat layout, on Windows too.
      expect(normalizeHookInput({ transcript_path: 'C:\\Users\\chris\\.cursor\\projects\\x\\agent-transcripts\\abc-123.txt' }).sessionId).toBe('abc-123');
      expect(normalizeHookInput({ transcript_path: '/fixture/not-a-cursor-transcript.jsonl' }).sessionId).toBeUndefined();
    });

    it('reads the session id from the harness\'s own variable, after the payload', () => {
      named('gemini');
      process.env.GEMINI_SESSION_ID = 'gemini-sess-123';
      expect(normalizeHookInput({}).sessionId).toBe('gemini-sess-123');
      expect(normalizeHookInput({ session_id: 'input-sid' }).sessionId).toBe('input-sid');
    });

    it('falls back to MYCO_SESSION_ID, after the payload', () => {
      named('claude-code');
      process.env.MYCO_SESSION_ID = 'env-session';
      expect(normalizeHookInput({}).sessionId).toBe('env-session');
      expect(normalizeHookInput({ session_id: 'input-session' }).sessionId).toBe('input-session');
    });

    it('resolves dot-notation paths, and leaves a missing one undefined', () => {
      setHookConfig([{ name: 'nested', configDir: '.nested', pluginRootEnvVar: 'NESTED_PLUGIN_ROOT', hookFields: {
        ...FIELDS, transcriptPath: 'tool_info.transcript_path', lastResponse: 'tool_info.response', toolName: 'tool_info.name', toolInput: 'tool_info.input', toolOutput: 'tool_info.output',
      } }]);
      named('nested');
      expect(normalizeHookInput({ session_id: 's1', tool_info: { transcript_path: '/n', response: 'r', name: 'T', input: { x: 1 }, output: 'done' } }))
        .toMatchObject({ transcriptPath: '/n', lastResponse: 'r', toolName: 'T', toolInput: { x: 1 }, toolOutput: 'done' });
      expect(normalizeHookInput({ session_id: 's1' })).toMatchObject({ transcriptPath: undefined, toolName: undefined, toolInput: undefined });
    });
  });

  describe('readSymbiontFlag (pure argv parser)', () => {
    it('reads --symbiont <name> and --symbiont=<name>, anywhere in argv', () => {
      expect(readSymbiontFlag(['hook', 'session-start', '--symbiont', 'codex'])).toBe('codex');
      expect(readSymbiontFlag(['hook', 'session-start', '--symbiont=codex'])).toBe('codex');
      expect(readSymbiontFlag(['--symbiont', 'windsurf', 'hook', 'stop'])).toBe('windsurf');
    });

    it('returns undefined when the flag is absent, dangling, or followed by another flag', () => {
      expect(readSymbiontFlag(['hook', 'session-start'])).toBeUndefined();
      expect(readSymbiontFlag(['hook', 'session-start', '--symbiont'])).toBeUndefined();
      expect(readSymbiontFlag(['--symbiont', '--debug'])).toBeUndefined();
    });
  });
});
