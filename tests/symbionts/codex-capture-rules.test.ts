import { describe, it, expect } from 'vitest';
import { loadManifests } from '../../src/symbionts/detect.js';
import {
  evaluateUserPromptRules,
  evaluateSessionStartRules,
} from '../../src/hooks/capture-rules.js';

/**
 * Integration test that exercises the REAL codex.yaml manifest through
 * the Zod schema and both rule evaluators — end-to-end for the
 * structural behaviors the branch ships:
 *
 *   1. Agent detection via transcript_path / configDir matching lives
 *      in normalize.ts and is unit-tested separately.
 *   2. Phantom sub-invocation drop is a two-layer defense:
 *        a) session_start rule — stops the phantom from ever being
 *           registered as a session row.
 *        b) user_prompt rule — safety net for phantoms that slipped
 *           past SessionStart, deletes the registered row.
 *
 * These guard against silent regressions if someone edits the YAML and
 * breaks the schema, or if an evaluator signature changes and the
 * codex.yaml contract no longer round-trips.
 */
describe('codex.yaml capture rules', () => {
  it('parses cleanly through the Zod schema', () => {
    const manifests = loadManifests();
    const codex = manifests.find((m) => m.name === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.capture?.rules).toBeDefined();
    // At minimum: one session_start rule + one user_prompt rule.
    expect(codex!.capture!.rules!.length).toBeGreaterThanOrEqual(2);
  });

  it('declares both a session_start rule and a user_prompt rule', () => {
    const manifests = loadManifests();
    const codex = manifests.find((m) => m.name === 'codex')!;
    const rules = codex.capture!.rules!;
    expect(rules.some((r) => r.event === 'session_start')).toBe(true);
    expect(rules.some((r) => r.event === 'user_prompt')).toBe(true);
  });

  describe('layer 1 — session_start drop', () => {
    it('drops when Codex SessionStart has no transcript_path', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'codex', {
        transcriptPath: undefined,
      });
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });

    it('drops even when detected agent defaults to claude-code', () => {
      // Detection fails when transcript_path is null (the detector's
      // signal is the very thing that's missing). The rule's scope:
      // any_agent ensures it fires regardless of the fallback.
      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: undefined,
      });
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });

    it('passes a real Codex SessionStart through', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'codex', {
        transcriptPath: '/Users/chris/.codex/sessions/2026/04/11/rollout-abc.jsonl',
      });
      expect(result).toEqual({ action: 'pass' });
    });
  });

  describe('layer 2 — user_prompt safety net', () => {
    it('drops a phantom UserPromptSubmit with no transcript_path', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'codex', {
        prompt: 'You are a helpful assistant. Please title this task.',
        transcriptPath: undefined,
      });
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });

    it('drops a phantom even when the hook misattributed the agent', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'claude-code', {
        prompt: 'anything',
        transcriptPath: '',
      });
      expect(result).toEqual({ action: 'drop', reason: 'ephemeral-sub-invocation' });
    });

    it('passes a real Codex user prompt through unchanged', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'codex', {
        prompt: 'real user question',
        transcriptPath: '/Users/chris/.codex/sessions/2026/04/11/rollout-abc.jsonl',
      });
      expect(result).toEqual({ action: 'pass', prompt: 'real user question' });
    });
  });

  describe('file-mention preamble rewrite', () => {
    it('strips Codex Desktop file-mention preamble from screenshot prompts', () => {
      const prompt = '\n# Files mentioned by the user:\n\n## CleanShot 2026-04-13.png: /Users/chris/Library/Application Support/CleanShot/media/screenshot.png\n\n## My request for Codex:\nhello, what do you see?\n';
      const result = evaluateUserPromptRules(loadManifests(), 'codex', {
        prompt,
        transcriptPath: '/Users/chris/.codex/sessions/2026/04/13/rollout-abc.jsonl',
      });
      expect(result.action).toBe('rewrite');
      if (result.action === 'rewrite') {
        expect(result.prompt).toBe('hello, what do you see?');
        expect(result.reason).toBe('codex-desktop-file-preamble');
      }
    });

    it('passes normal prompts without preamble through unchanged', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'codex', {
        prompt: 'Fix the bug in main.ts',
        transcriptPath: '/Users/chris/.codex/sessions/2026/04/13/rollout-abc.jsonl',
      });
      expect(result).toEqual({ action: 'pass', prompt: 'Fix the bug in main.ts' });
    });
  });
});
