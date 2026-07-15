/**
 * Manifest-derived system-envelope prompt matchers.
 *
 * Symbiont runtimes inject synthetic user-role transcript entries — skill
 * expansions, sub-agent notifications, environment refreshes. Each manifest
 * already classifies those via `capture.rules` entries of the form
 * `{ event: user_prompt, when: { prompt_starts_with | prompt_envelope_tag_in },
 * action: classify, set_origin: <non-human> }`. These helpers harvest the
 * matchers from the build-time generated hook config so transcript parsers
 * can treat such entries as mid-turn envelopes rather than turn boundaries —
 * without any prompt strings hardcoded in parser code.
 */

import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';

/** True for a rule that classifies (not drops/rewrites) its match as non-human. */
function isSystemEnvelopeClassifyRule(rule: {
  event: string;
  action: string;
  set_origin?: string;
}): boolean {
  if (rule.event !== 'user_prompt') return false;
  if (rule.action !== 'classify') return false;
  return Boolean(rule.set_origin) && rule.set_origin !== 'human';
}

/**
 * Prompt prefixes whose user-role transcript entries are runtime-synthesized
 * system envelopes for `agent`, per its manifest capture rules. A user
 * message starting with one of these is NOT a new conversational turn.
 *
 * Covers rules keyed on `prompt_starts_with` (non-XML self-prompts like
 * claude-code's `<<autonomous-loop`). Structural envelope-tag rules are
 * harvested separately by {@link systemEnvelopeTags} — see that function for
 * why the two need different matching semantics.
 */
export function systemEnvelopePrefixes(agent: string): string[] {
  const rules = HOOK_CONFIG[agent]?.captureRules ?? [];
  const prefixes: string[] = [];
  for (const rule of rules) {
    if (!isSystemEnvelopeClassifyRule(rule)) continue;
    const prefix = rule.when.prompt_starts_with;
    if (prefix) prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * Tag names whose user-role transcript entries are runtime-synthesized
 * system envelopes for `agent`, per its manifest's structural
 * `prompt_envelope_tag_in` capture rules. Pair with {@link envelopeTagAtStart}
 * (from `hooks/capture-rules.js`) at the call site — that predicate is
 * attribute-robust (matches `<tag ...>` and `<tag/>`, not just a literal
 * prefix string), which a plain `startsWith` prefix can't express.
 */
export function systemEnvelopeTags(agent: string): string[] {
  const rules = HOOK_CONFIG[agent]?.captureRules ?? [];
  const tags: string[] = [];
  for (const rule of rules) {
    if (!isSystemEnvelopeClassifyRule(rule)) continue;
    const ruleTags = rule.when.prompt_envelope_tag_in;
    if (ruleTags) tags.push(...ruleTags);
  }
  return tags;
}
