/**
 * Manifest-derived system-envelope prompt prefixes.
 *
 * Symbiont runtimes inject synthetic user-role transcript entries — skill
 * expansions, sub-agent notifications, environment refreshes. Each manifest
 * already classifies those via `capture.rules` entries of the form
 * `{ event: user_prompt, when: { prompt_starts_with }, action: classify,
 * set_origin: <non-human> }`. This helper harvests the prefixes from the
 * build-time generated hook config so transcript parsers can treat such
 * entries as mid-turn envelopes rather than turn boundaries — without any
 * prompt strings hardcoded in parser code.
 */

import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';

/**
 * Prompt prefixes whose user-role transcript entries are runtime-synthesized
 * system envelopes for `agent`, per its manifest capture rules. A user
 * message starting with one of these is NOT a new conversational turn.
 */
export function systemEnvelopePrefixes(agent: string): string[] {
  const rules = HOOK_CONFIG[agent]?.captureRules ?? [];
  const prefixes: string[] = [];
  for (const rule of rules) {
    if (rule.event !== 'user_prompt') continue;
    if (rule.action !== 'classify') continue;
    if (!rule.set_origin || rule.set_origin === 'human') continue;
    const prefix = rule.when.prompt_starts_with;
    if (prefix) prefixes.push(prefix);
  }
  return prefixes;
}
