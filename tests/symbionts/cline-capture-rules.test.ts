import { describe, expect, it } from 'bun:test';
import { evaluateUserPromptRules } from '@myco/hooks/capture-rules.js';
import { loadManifests } from '@myco/symbionts/detect.js';

describe('cline.yaml capture rules', () => {
  const cline = () => loadManifests().find((m) => m.name === 'cline')!;

  it('declares Cline user_input envelope rules', () => {
    const envelopes = (cline().capture?.rules ?? [])
      .filter((r) => r.action === 'rewrite_prompt' && r.strip_envelope)
      .map((r) => r.strip_envelope);

    expect(envelopes).toContainEqual({ open: '<user_input mode="act">', close: '</user_input>' });
    expect(envelopes).toContainEqual({ open: '<user_input mode="plan">', close: '</user_input>' });
  });

  it('strips Cline act and plan user_input envelopes', () => {
    for (const mode of ['act', 'plan']) {
      const result = evaluateUserPromptRules(loadManifests(), 'cline', {
        prompt: `<user_input mode="${mode}">Do not use shell.\nReply ok.</user_input>`,
      });

      expect(result).toMatchObject({
        action: 'rewrite',
        prompt: 'Do not use shell.\nReply ok.',
      });
    }
  });

  it('leaves malformed or empty Cline user_input envelopes unchanged', () => {
    expect(evaluateUserPromptRules(loadManifests(), 'cline', {
      prompt: '<user_input mode="act">',
    })).toEqual({ action: 'pass', prompt: '<user_input mode="act">' });

    expect(evaluateUserPromptRules(loadManifests(), 'cline', {
      prompt: '<user_input mode="act"></user_input>',
    })).toEqual({ action: 'pass', prompt: '<user_input mode="act"></user_input>' });
  });
});
