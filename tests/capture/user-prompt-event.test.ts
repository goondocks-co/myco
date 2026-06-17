import { describe, expect, it } from 'bun:test';
import { normalizeAcceptedUserPromptEvent, type CaptureEvent } from '@myco/capture/user-prompt-event.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

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

function userPrompt(prompt: string): CaptureEvent {
  return {
    type: 'user_prompt',
    session_id: 'session-1',
    timestamp: '2026-06-17T00:00:00.000Z',
    agent: 'cline',
    prompt,
  };
}

describe('normalizeAcceptedUserPromptEvent', () => {
  it('applies manifest rewrite_prompt rules to live user_prompt events', () => {
    const manifest = manifestWithRules('cline', [{
      event: 'user_prompt',
      when: { prompt_starts_with: '<user_input mode="act">' },
      action: 'rewrite_prompt',
      strip_envelope: { open: '<user_input mode="act">', close: '</user_input>' },
      reason: 'strip Cline act user_input envelope',
    }]);

    const result = normalizeAcceptedUserPromptEvent(
      userPrompt('<user_input mode="act">Use no tools.\nReply ok.</user_input>'),
      { manifests: [manifest] },
    );

    expect(result.action).toBe('rewrite');
    expect(result.event.prompt).toBe('Use no tools.\nReply ok.');
    expect(result.reason).toBe('strip Cline act user_input envelope');
  });

  it('applies manifest origin classification without overwriting explicit event origin', () => {
    const manifest = manifestWithRules('cline', [{
      event: 'user_prompt',
      when: { prompt_starts_with: '<system-note>' },
      action: 'classify',
      set_origin: 'system',
    }]);

    const classified = normalizeAcceptedUserPromptEvent(userPrompt('<system-note>hello'), {
      manifests: [manifest],
    });
    expect(classified.event.origin).toBe('system');

    const explicit = normalizeAcceptedUserPromptEvent({
      ...userPrompt('<system-note>hello'),
      origin: 'agent_dispatch',
    }, {
      manifests: [manifest],
    });
    expect(explicit.event.origin).toBe('agent_dispatch');
  });

  it('does not apply drop rules at the accepted-event normalization boundary', () => {
    const manifest = manifestWithRules('cline', [{
      event: 'user_prompt',
      when: { prompt_contains: 'drop me' },
      action: 'drop',
      reason: 'not admitted elsewhere',
    }]);

    const event = userPrompt('drop me');
    const result = normalizeAcceptedUserPromptEvent(event, { manifests: [manifest] });

    expect(result).toMatchObject({
      action: 'pass',
      event,
      ignoredDropReason: 'not admitted elsewhere',
    });
  });
});
