import { describe, it, expect } from 'bun:test';

import { evaluateUserPromptRules } from '@myco/hooks/capture-rules.js';

/**
 * Codex injects AGENTS.md plus the Myco cortex context as the first
 * user-role entry of every rollout. It is machine context, not a prompt, and
 * the manifest drops it.
 *
 * The rule keyed on `prompt_starts_with` until Codex began prefixing the
 * injection with a `<recommended_plugins>` envelope. The marker was no longer
 * at position 0, the rule silently stopped firing, and 55 injections were
 * captured as prompts in one day — each a ~20 KB blob stored as if a person
 * had typed it. The capture fidelity audit surfaced it as an envelope
 * classified against a human origin.
 */
describe('codex AGENTS.md context injection', () => {
  it('drops the injection when it starts the prompt', () => {
    const decision = evaluateUserPromptRules('codex', {
      prompt: '# AGENTS.md instructions for /repo\n\nsome guidance',
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(decision.action).toBe('drop');
  });

  it('drops it when an envelope precedes it — the regression that broke this', () => {
    const decision = evaluateUserPromptRules('codex', {
      prompt:
        '<recommended_plugins>\nplugin list\n</recommended_plugins>\n' +
        '# AGENTS.md instructions for /Users/chris/Repos/myco\n\n<INSTRUCTIONS>guidance</INSTRUCTIONS>',
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(decision.action).toBe('drop');
  });

  it('leaves a real prompt that merely mentions AGENTS.md alone', () => {
    const decision = evaluateUserPromptRules('codex', {
      prompt: 'please update AGENTS.md with the new build step',
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(decision.action).toBe('pass');
  });

  it('keeps a human prompt that quotes the marker mid-sentence', () => {
    // The reason the enveloped rule requires BOTH conditions. A bare substring
    // match paired with `drop` would discard this entirely, and a drop is
    // unrecoverable — only proven noise may be dropped.
    const decision = evaluateUserPromptRules('codex', {
      prompt: 'why does the rule key on "# AGENTS.md instructions" instead of a tag?',
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(decision.action).toBe('pass');
  });

  it('keeps an envelope-prefixed prompt that does NOT carry the marker', () => {
    const decision = evaluateUserPromptRules('codex', {
      prompt: '<recommended_plugins>\nplugin list\n</recommended_plugins>\nplease review this',
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(decision.action).not.toBe('drop');
  });
});
