/**
 * The generated hook config carries the hook timeouts the harness templates declare.
 *
 * `packages/myco/src/hooks/hook-config.generated.ts` is what every hook reads instead of the YAML manifests, and it
 * carries the per-event hook timeouts copied from `symbionts/templates/<sym>/hooks.json`: the one source the member's
 * hook budget and the installer's emitted timeouts share. That the committed file matches a fresh generation is the
 * build job's to prove ("generators preserve the checkout" runs every codegen generator), and `npm run check:pr` runs
 * the same generators locally.
 */
import { describe, expect, it } from 'bun:test';
import { collectHookEvents } from '../../packages/myco/scripts/gen-hook-config';
import { HOOK_CONFIG } from '../../packages/myco/src/hooks/hook-config.generated';

describe('generated hook config', () => {
  it('carries the per-event timeouts the harness templates declare, keyed by harness event name', () => {
    // Spot-pin the Claude Code budget the member derives from (spec §2):
    // UserPromptSubmit 5 s, SessionStart 10 s, Stop 30 s, SessionEnd 10 s.
    expect(HOOK_CONFIG['claude-code'].hookEvents.SessionEnd).toEqual({ hook: 'session-end', timeout: 10 });
    expect(HOOK_CONFIG['claude-code'].hookEvents.UserPromptSubmit).toEqual({ hook: 'user-prompt-submit', timeout: 5 });
    expect(HOOK_CONFIG['claude-code'].hookEvents.SessionStart).toEqual({ hook: 'session-start', timeout: 10 });
    expect(HOOK_CONFIG['claude-code'].hookEvents.Stop).toEqual({ hook: 'stop', timeout: 30 });
    // Antigravity nests its events under a `myco` key; the harness event name is still the key.
    expect(HOOK_CONFIG.antigravity.hookEvents.PreInvocation).toEqual({ hook: 'session-start', timeout: 10 });
    // Windsurf declares no timeouts; the events are still present so a budget reader sees "undeclared".
    expect(HOOK_CONFIG.windsurf.hookEvents.post_cascade_response).toEqual({ hook: 'stop' });
    // Plugin-file symbionts have no hooks.json template.
    expect(HOOK_CONFIG.opencode.hookEvents).toEqual({});
  });

  it('refuses a template that wires one hook name with two different timeouts', () => {
    // A hook process knows its hook name, not the harness event, so a budget
    // read by hook name must have exactly one answer per symbiont.
    const twoTimeouts = {
      post_cascade_response: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf --phases response', timeout: 7 }],
      post_cascade_response_with_transcript: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf --phases transcript', timeout: 9 }],
    };
    expect(() => collectHookEvents(twoTimeouts, 'windsurf/hooks.json'))
      .toThrow('windsurf/hooks.json: hook stop is wired with different timeouts across events');

    const oneDeclaredOneOmitted = {
      post_cascade_response: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf --phases response', timeout: 7 }],
      post_cascade_response_with_transcript: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf --phases transcript' }],
    };
    expect(() => collectHookEvents(oneDeclaredOneOmitted, 'windsurf/hooks.json'))
      .toThrow('windsurf/hooks.json: hook stop is wired with different timeouts across events');

    const consistent = {
      post_cascade_response: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf --phases response' }],
      post_cascade_response_with_transcript: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf --phases transcript' }],
    };
    expect(collectHookEvents(consistent, 'windsurf/hooks.json')).toEqual({
      post_cascade_response: { hook: 'stop' },
      post_cascade_response_with_transcript: { hook: 'stop' },
    });
  });
});
