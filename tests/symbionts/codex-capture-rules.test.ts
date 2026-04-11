import { describe, it, expect } from 'vitest';
import { loadManifests } from '../../src/symbionts/detect.js';
import { evaluateUserPromptRules } from '../../src/hooks/capture-rules.js';

/**
 * Integration test that exercises the REAL codex.yaml manifest through
 * the Zod schema and the rule evaluator — end-to-end for the two
 * structural behaviors the PR ships:
 *   1. Agent detection via transcript_path / configDir matching lives
 *      in normalize.ts and is unit-tested separately.
 *   2. Phantom sub-invocation drop via `transcript_path_missing: true`
 *      lives in the Codex manifest and is verified here.
 *
 * These guard against silent regressions if someone edits the YAML and
 * breaks the schema, or if the evaluator signature changes and the
 * codex.yaml contract no longer round-trips.
 */
describe('codex.yaml capture rules', () => {
  it('parses cleanly through the Zod schema', () => {
    const manifests = loadManifests();
    const codex = manifests.find((m) => m.name === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.capture?.rules).toBeDefined();
    expect(codex!.capture!.rules!.length).toBeGreaterThan(0);
  });

  it('drops a Codex UserPromptSubmit with no transcript_path (phantom sub-invocation)', () => {
    const manifests = loadManifests();
    const result = evaluateUserPromptRules(manifests, 'codex', {
      prompt: 'You are a helpful assistant. Please title this task.',
      transcriptPath: undefined,
    });
    expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
  });

  it('drops a phantom even when the hook misattributed the agent to claude-code', () => {
    // Detection falls back to claude-code when transcript_path is
    // missing (no signal for the detector). The rule is scope: any_agent
    // specifically to survive that fallback.
    const manifests = loadManifests();
    const result = evaluateUserPromptRules(manifests, 'claude-code', {
      prompt: 'anything',
      transcriptPath: '',
    });
    expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
  });

  it('passes a real Codex session through unchanged', () => {
    const manifests = loadManifests();
    const result = evaluateUserPromptRules(manifests, 'codex', {
      prompt: 'real user question',
      transcriptPath: '/Users/chris/.codex/sessions/2026/04/11/rollout-abc.jsonl',
    });
    expect(result).toEqual({ action: 'pass', prompt: 'real user question' });
  });
});
