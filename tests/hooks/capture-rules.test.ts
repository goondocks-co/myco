import { describe, it, expect } from 'vitest';
import {
  evaluateUserPromptRules,
  evaluateSessionStartRules,
  type UserPromptRuleContext,
} from '@myco/hooks/capture-rules.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

/**
 * Minimal manifest factory — only the fields the evaluator actually reads.
 * Using `as unknown as SymbiontManifest` keeps the test focused on rule
 * behavior rather than the surrounding manifest shape.
 */
function manifestWithRules(name: string, rules: unknown[]): SymbiontManifest {
  return {
    name,
    displayName: name,
    binary: name,
    configDir: `.${name}`,
    pluginRootEnvVar: `${name.toUpperCase()}_PLUGIN_ROOT`,
    hookFields: {
      sessionId: 'session_id',
      transcriptPath: 'transcript_path',
      lastResponse: 'last_assistant_message',
      prompt: 'prompt',
      toolName: 'tool_name',
      toolInput: 'tool_input',
      toolOutput: 'tool_output',
    },
    capture: { planDirs: [], rules: rules as never },
  } as unknown as SymbiontManifest;
}

/** Helper — build a context with defaults, override only what the test cares about. */
function ctx(partial: Partial<UserPromptRuleContext> = {}): UserPromptRuleContext {
  return {
    prompt: partial.prompt ?? 'default prompt text',
    transcriptPath: partial.transcriptPath,
    transcriptMeta: partial.transcriptMeta,
  };
}

describe('evaluateUserPromptRules', () => {
  describe('pass-through', () => {
    it('passes the prompt through unchanged when no manifests have rules', () => {
      const result = evaluateUserPromptRules([], 'codex', ctx({ prompt: 'hello world' }));
      expect(result).toEqual({ action: 'pass', prompt: 'hello world' });
    });

    it('passes unchanged when no rule condition matches', () => {
      const m = manifestWithRules('codex', [
        { event: 'user_prompt', when: { prompt_starts_with: 'nope' }, action: 'drop', trim: true },
      ]);
      const result = evaluateUserPromptRules([m], 'codex', ctx({ prompt: 'hello world' }));
      expect(result).toEqual({ action: 'pass', prompt: 'hello world' });
    });

    it('ignores rules whose event is not user_prompt', () => {
      const m = manifestWithRules('codex', [
        { event: 'tool_use', when: { prompt_starts_with: 'hello' }, action: 'drop', trim: true },
      ]);
      const result = evaluateUserPromptRules([m], 'codex', ctx({ prompt: 'hello world' }));
      expect(result).toEqual({ action: 'pass', prompt: 'hello world' });
    });
  });

  describe('structural condition: transcript_path_missing', () => {
    const missingRule = manifestWithRules('codex', [
      {
        event: 'user_prompt',
        scope: 'any_agent',
        when: { transcript_path_missing: true },
        action: 'drop',
        reason: 'ephemeral-sub-invocation',
        trim: true,
      },
    ]);

    it('drops when transcript_path is undefined', () => {
      const result = evaluateUserPromptRules([missingRule], 'codex', ctx({ prompt: 'anything' }));
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });

    it('drops when transcript_path is an empty string', () => {
      const result = evaluateUserPromptRules(
        [missingRule],
        'codex',
        ctx({ prompt: 'anything', transcriptPath: '' }),
      );
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });

    it('does NOT drop when transcript_path is populated', () => {
      const result = evaluateUserPromptRules(
        [missingRule],
        'codex',
        ctx({
          prompt: 'anything',
          transcriptPath: '/Users/me/.codex/sessions/2026/04/11/rollout-abc.jsonl',
        }),
      );
      expect(result).toEqual({ action: 'pass', prompt: 'anything' });
    });

    it('fires even when the hook misattributed the agent (scope: any_agent)', () => {
      // This matters because detection itself uses transcript_path; when
      // transcript_path is missing, the hook typically defaults the agent
      // to claude-code. The rule must still fire to clean up the phantom.
      const result = evaluateUserPromptRules([missingRule], 'claude-code', ctx({ prompt: 'x' }));
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });
  });

  describe('scope enforcement', () => {
    const textRule = manifestWithRules('codex', [
      {
        event: 'user_prompt',
        scope: 'this_agent',
        when: { prompt_contains: 'hello' },
        action: 'drop',
        reason: 'codex-only',
        trim: true,
      },
    ]);

    it('fires when detected agent matches the manifest owner', () => {
      const result = evaluateUserPromptRules([textRule], 'codex', ctx({ prompt: 'hello there' }));
      expect(result).toEqual({ action: 'drop', reason: 'codex-only' });
    });

    it('does NOT fire when detected agent differs under this_agent scope', () => {
      const result = evaluateUserPromptRules([textRule], 'claude-code', ctx({ prompt: 'hello there' }));
      expect(result).toEqual({ action: 'pass', prompt: 'hello there' });
    });
  });

  describe('rewrite_prompt action (reserved for future structural upgrade)', () => {
    it('extracts text after extract_after marker', () => {
      const m = manifestWithRules('codex', [
        {
          event: 'user_prompt',
          scope: 'this_agent',
          when: { prompt_contains: '---BODY---' },
          action: 'rewrite_prompt',
          extract_after: '---BODY---',
          trim: true,
          reason: 'marker-extract',
        },
      ]);
      const result = evaluateUserPromptRules(
        [m],
        'codex',
        ctx({ prompt: 'preamble text ---BODY--- real content here\n' }),
      );
      expect(result).toEqual({
        action: 'rewrite',
        prompt: 'real content here',
        reason: 'marker-extract',
      });
    });

    it('falls through to pass when the marker is absent', () => {
      const m = manifestWithRules('codex', [
        {
          event: 'user_prompt',
          when: { prompt_starts_with: 'X' },
          action: 'rewrite_prompt',
          extract_after: '---BODY---',
          trim: true,
        },
      ]);
      const result = evaluateUserPromptRules([m], 'codex', ctx({ prompt: 'X no body here' }));
      expect(result).toEqual({ action: 'pass', prompt: 'X no body here' });
    });

    it('does not emit an empty prompt when extraction yields whitespace only', () => {
      const m = manifestWithRules('codex', [
        {
          event: 'user_prompt',
          when: { prompt_starts_with: 'A' },
          action: 'rewrite_prompt',
          extract_after: 'END',
          trim: true,
        },
      ]);
      const result = evaluateUserPromptRules([m], 'codex', ctx({ prompt: 'AEND   \n\t  ' }));
      expect(result).toEqual({ action: 'pass', prompt: 'AEND   \n\t  ' });
    });
  });

  describe('rule ordering', () => {
    it('applies the first matching rule and stops', () => {
      const m = manifestWithRules('codex', [
        { event: 'user_prompt', when: { prompt_contains: 'foo' }, action: 'drop', reason: 'first', trim: true },
        { event: 'user_prompt', when: { prompt_contains: 'foo' }, action: 'rewrite_prompt', extract_after: 'foo', reason: 'second', trim: true },
      ]);
      const result = evaluateUserPromptRules([m], 'codex', ctx({ prompt: 'foo bar' }));
      expect(result).toEqual({ action: 'drop', reason: 'first' });
    });

    it('checks rules across manifests in manifest order', () => {
      const claude = manifestWithRules('claude-code', [
        { event: 'user_prompt', when: { prompt_contains: 'hello' }, action: 'drop', reason: 'claude-rule', trim: true },
      ]);
      const codex = manifestWithRules('codex', [
        { event: 'user_prompt', when: { prompt_contains: 'hello' }, action: 'drop', reason: 'codex-rule', trim: true },
      ]);
      const result = evaluateUserPromptRules([claude, codex], 'claude-code', ctx({ prompt: 'hello' }));
      expect(result).toEqual({ action: 'drop', reason: 'claude-rule' });
    });
  });

  describe('defense against malformed rules', () => {
    it('ignores a rule with no conditions (no blanket matching)', () => {
      const m = manifestWithRules('codex', [
        { event: 'user_prompt', when: {}, action: 'drop', reason: 'oops', trim: true },
      ]);
      const result = evaluateUserPromptRules([m], 'codex', ctx({ prompt: 'any prompt at all' }));
      expect(result).toEqual({ action: 'pass', prompt: 'any prompt at all' });
    });
  });
});

describe('evaluateSessionStartRules', () => {
  const dropRule = manifestWithRules('codex', [
    {
      event: 'session_start',
      scope: 'any_agent',
      when: { transcript_path_missing: true },
      action: 'drop',
      reason: 'ephemeral-sub-invocation',
      trim: true,
    },
  ]);

  it('drops when transcript_path is missing at SessionStart', () => {
    const result = evaluateSessionStartRules([dropRule], 'codex', { transcriptPath: undefined });
    expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
  });

  it('passes when transcript_path is populated at SessionStart', () => {
    const result = evaluateSessionStartRules([dropRule], 'codex', {
      transcriptPath: '/Users/me/.codex/sessions/2026/04/11/rollout-abc.jsonl',
    });
    expect(result).toEqual({ action: 'pass' });
  });

  it('fires even when the detected agent differs (scope: any_agent)', () => {
    // Detection typically fails for ephemeral sub-invocations because
    // transcript_path is the detection signal. Scope `any_agent`
    // ensures the rule still fires under the claude-code default.
    const result = evaluateSessionStartRules([dropRule], 'claude-code', { transcriptPath: undefined });
    expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
  });

  it('ignores user_prompt rules even when conditions would match', () => {
    // A user_prompt rule must not accidentally fire at SessionStart time.
    const m = manifestWithRules('codex', [
      {
        event: 'user_prompt',
        scope: 'any_agent',
        when: { transcript_path_missing: true },
        action: 'drop',
        reason: 'user-prompt-only',
        trim: true,
      },
    ]);
    const result = evaluateSessionStartRules([m], 'codex', { transcriptPath: undefined });
    expect(result).toEqual({ action: 'pass' });
  });

  it('ignores session_start rules that use prompt-text conditions', () => {
    // No prompt exists at SessionStart, so prompt_starts_with is unreachable.
    // The rule should silently fail to match rather than fire on empty input.
    const m = manifestWithRules('codex', [
      {
        event: 'session_start',
        scope: 'any_agent',
        when: { prompt_starts_with: 'anything' },
        action: 'drop',
        reason: 'prompt-on-session-start',
        trim: true,
      },
    ]);
    const result = evaluateSessionStartRules([m], 'codex', { transcriptPath: undefined });
    expect(result).toEqual({ action: 'pass' });
  });

  it('respects this_agent scope when the detected agent matches', () => {
    const m = manifestWithRules('codex', [
      {
        event: 'session_start',
        scope: 'this_agent',
        when: { transcript_path_missing: true },
        action: 'drop',
        reason: 'codex-only',
        trim: true,
      },
    ]);
    expect(evaluateSessionStartRules([m], 'codex', { transcriptPath: undefined })).toEqual({
      action: 'drop',
      reason: 'codex-only',
    });
    expect(evaluateSessionStartRules([m], 'claude-code', { transcriptPath: undefined })).toEqual({
      action: 'pass',
    });
  });
});

describe('transcript_meta_field_exists condition', () => {
  const subagentRule = manifestWithRules('codex', [
    {
      event: 'session_start',
      scope: 'this_agent',
      when: { transcript_meta_field_exists: 'source.subagent' },
      action: 'drop',
      reason: 'subagent-thread-spawn',
      trim: true,
    },
  ]);

  const subagentMeta = {
    source: { subagent: { thread_spawn: { parent_thread_id: 'abc', depth: 1 } } },
  };
  const userMeta = { source: 'vscode' };

  describe('evaluateSessionStartRules', () => {
    it('drops when the meta field exists (sub-agent session)', () => {
      const result = evaluateSessionStartRules([subagentRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: subagentMeta,
      });
      expect(result).toEqual({ action: 'drop', reason: 'subagent-thread-spawn' });
    });

    it('passes when the meta field does not exist (user session)', () => {
      const result = evaluateSessionStartRules([subagentRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: userMeta,
      });
      expect(result).toEqual({ action: 'pass' });
    });

    it('passes when transcriptMeta is undefined (file unreadable)', () => {
      const result = evaluateSessionStartRules([subagentRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: undefined,
      });
      expect(result).toEqual({ action: 'pass' });
    });

    it('passes when field path resolves to a falsy value', () => {
      const result = evaluateSessionStartRules([subagentRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: { source: { subagent: null } },
      });
      expect(result).toEqual({ action: 'pass' });
    });
  });

  describe('evaluateUserPromptRules (safety net)', () => {
    const promptRule = manifestWithRules('codex', [
      {
        event: 'user_prompt',
        scope: 'this_agent',
        when: { transcript_meta_field_exists: 'source.subagent' },
        action: 'drop',
        reason: 'subagent-thread-spawn',
        trim: true,
      },
    ]);

    it('drops the prompt when the meta field exists', () => {
      const result = evaluateUserPromptRules([promptRule], 'codex', ctx({
        prompt: 'Review this code',
        transcriptMeta: subagentMeta,
      }));
      expect(result).toEqual({ action: 'drop', reason: 'subagent-thread-spawn' });
    });

    it('passes the prompt when the meta field is absent', () => {
      const result = evaluateUserPromptRules([promptRule], 'codex', ctx({
        prompt: 'Review this code',
        transcriptMeta: userMeta,
      }));
      expect(result).toEqual({ action: 'pass', prompt: 'Review this code' });
    });
  });

  describe('deep field navigation', () => {
    it('handles multi-level dot-paths', () => {
      const deepRule = manifestWithRules('agent', [
        {
          event: 'session_start',
          scope: 'this_agent',
          when: { transcript_meta_field_exists: 'source.subagent.thread_spawn.depth' },
          action: 'drop',
          reason: 'deep-field',
          trim: true,
        },
      ]);
      const result = evaluateSessionStartRules([deepRule], 'agent', {
        transcriptPath: '/path.jsonl',
        transcriptMeta: subagentMeta,
      });
      expect(result).toEqual({ action: 'drop', reason: 'deep-field' });
    });

    it('returns pass for partial path that stops at a non-object', () => {
      const deepRule = manifestWithRules('agent', [
        {
          event: 'session_start',
          scope: 'this_agent',
          when: { transcript_meta_field_exists: 'source.subagent.nonexistent' },
          action: 'drop',
          reason: 'missing-deep',
          trim: true,
        },
      ]);
      const result = evaluateSessionStartRules([deepRule], 'agent', {
        transcriptPath: '/path.jsonl',
        transcriptMeta: userMeta, // source is a string, not an object
      });
      expect(result).toEqual({ action: 'pass' });
    });
  });
});

describe('transcript_meta_field_equals condition', () => {
  const execRule = manifestWithRules('codex', [
    {
      event: 'session_start',
      scope: 'this_agent',
      when: {
        transcript_meta_field_equals: {
          path: 'source',
          value: 'exec',
        },
      },
      action: 'drop',
      reason: 'noninteractive-exec',
      trim: true,
    },
  ]);

  describe('evaluateSessionStartRules', () => {
    it('drops when the meta field equals the configured scalar', () => {
      const result = evaluateSessionStartRules([execRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: { source: 'exec' },
      });
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-exec' });
    });

    it('passes when the meta field has a different value', () => {
      const result = evaluateSessionStartRules([execRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: { source: 'vscode' },
      });
      expect(result).toEqual({ action: 'pass' });
    });

    it('passes when the field is missing', () => {
      const result = evaluateSessionStartRules([execRule], 'codex', {
        transcriptPath: '/some/path.jsonl',
        transcriptMeta: { cwd: '/tmp/project' },
      });
      expect(result).toEqual({ action: 'pass' });
    });
  });

  describe('evaluateUserPromptRules', () => {
    const promptRule = manifestWithRules('codex', [
      {
        event: 'user_prompt',
        scope: 'this_agent',
        when: {
          transcript_meta_field_equals: {
            path: 'source',
            value: 'exec',
          },
        },
        action: 'drop',
        reason: 'noninteractive-exec',
        trim: true,
      },
    ]);

    it('drops the prompt when the meta field equals the configured scalar', () => {
      const result = evaluateUserPromptRules([promptRule], 'codex', ctx({
        prompt: 'reply with exactly ok',
        transcriptMeta: { source: 'exec' },
      }));
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-exec' });
    });
  });
});
