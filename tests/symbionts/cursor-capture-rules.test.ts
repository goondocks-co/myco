import { describe, it, expect } from 'bun:test';
import { loadManifests } from '@myco/symbionts/detect.js';
import { evaluateUserPromptRules } from '@myco/hooks/capture-rules.js';

/**
 * Integration test that exercises the REAL cursor.yaml manifest through the
 * Zod schema and the user-prompt rule evaluator — the `<user_query>`
 * envelope strip end to end.
 *
 * New Cursor app payloads (observed live 2026-06-11, smoke session
 * 64465029-53bf-43c2-bb6a-aea6627f56f4) wrap the user's text in
 * `<user_query>\n…\n</user_query>`. The manifest rule strips the envelope
 * so the stored prompt is the user's verbatim text. Guards against a YAML
 * edit silently breaking the rule.
 */
describe('cursor.yaml capture rules', () => {
  const cursor = () => loadManifests().find((m) => m.name === 'cursor')!;

  it('parses cleanly through the Zod schema and declares the envelope rule', () => {
    const rules = cursor().capture?.rules ?? [];
    const envelope = rules.find((r) => r.action === 'rewrite_prompt' && r.strip_envelope);
    expect(envelope).toBeDefined();
    expect(envelope!.strip_envelope).toEqual({ open: '<user_query>', close: '</user_query>' });
    expect(envelope!.when.prompt_starts_with).toBe('<user_query>');
  });

  it('strips the envelope from the exact smoke-run payload shape', () => {
    const inner = "This repo is myco's capture pipeline project. Read the file README.md and tell me its first heading, then write a new file /tmp/smoke-v2-cursor.txt containing exactly: smoke-v2 cursor verified";
    const result = evaluateUserPromptRules(loadManifests(), 'cursor', {
      prompt: `<user_query>\n${inner}\n</user_query>`,
    });
    expect(result.action).toBe('rewrite');
    expect((result as { prompt: string }).prompt).toBe(inner);
  });

  it('does not fire for other agents (this_agent scope)', () => {
    // transcriptPath provided so codex's unrelated any_agent phantom-drop
    // rule (transcript_path_missing) stays out of the way — this test is
    // about the cursor envelope rule not crossing the agent boundary.
    const wrapped = '<user_query>\nhello\n</user_query>';
    const result = evaluateUserPromptRules(loadManifests(), 'claude-code', {
      prompt: wrapped,
      transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
    });
    // Cursor's strip_envelope rewrite does not cross the agent boundary — the
    // prompt text itself is untouched. But the whole message is a single
    // unrecognized XML envelope, so claude-code's own fail-safe
    // (prompt_is_enclosing_envelope, ordered last) classifies it non-human
    // rather than letting it leak through as a human prompt.
    expect(result).toEqual({ action: 'pass', prompt: wrapped, origin: 'system' });
  });

  it('leaves unwrapped cursor prompts unchanged', () => {
    const result = evaluateUserPromptRules(loadManifests(), 'cursor', {
      prompt: 'plain prompt with no envelope',
    });
    expect(result).toEqual({ action: 'pass', prompt: 'plain prompt with no envelope' });
  });
});
