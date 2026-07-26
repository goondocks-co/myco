import fs from 'node:fs';

import { evaluateUserPromptRules } from '../../../hooks/capture-rules.js';
import { BUNDLED_MANIFESTS } from '../../../symbionts/manifests.generated.js';
import { SymbiontRegistry } from '../../../symbionts/registry.js';
import { manifestTranscriptDiscovery, enumerateTranscripts } from '../../../symbionts/transcript-discovery.js';
import type { AuditOptions, CoverageGap, Finding, SymbiontContext } from '../types.js';

/**
 * Drift detection: manifest rules that no longer match anything.
 *
 * This is the failure that has actually bitten. `claude-code.yaml` keyed on
 * `prompt_starts_with: "<teammate-message "`; Claude Code renamed the tag to
 * `<agent-message from="…">`, and every teammate report silently leaked as
 * `origin='human'` until someone noticed. The rule was still there, still
 * valid, and matching nothing.
 *
 * Symbionts ship updates continuously, so any rule keyed on a literal is one
 * upstream rename away from this. Replaying declared rules over real
 * transcripts and reporting the ones that never fire turns a silent rot into
 * a mechanical check.
 *
 * Rules are evaluated through the package's own `evaluateUserPromptRules`, so
 * the audit measures production behavior rather than a parallel opinion of it.
 */

/** Sampled prompts per symbiont — enough to be representative, bounded for cost. */
const DEFAULT_PROMPT_SAMPLE = 400;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Rules whose `when` block keys on prompt text alone.
 *
 * Only these are replayable from a prompt, and only these carry the rot risk
 * this check targets — a literal like `<teammate-message ` that upstream
 * renames. Rules keyed on transcript metadata (`transcript_meta_field_exists`,
 * `transcript_path_missing`) need context a text replay does not have, so
 * including them would report every one of them as dead.
 */
const TEXT_KEYED_CONDITIONS = ['prompt_starts_with', 'prompt_envelope_tag_in', 'prompt_contains'];

function declaredPromptRules(agent: string): Array<{ reason: string; action: string }> {
  const rules = BUNDLED_MANIFESTS.find((m) => m.name === agent)?.capture?.rules ?? [];
  return rules
    .filter((r) => r.event === 'user_prompt' && r.reason)
    .filter((r) => {
      const conditions = Object.keys((r.when ?? {}) as Record<string, unknown>);
      return (
        conditions.length > 0 && conditions.every((c) => TEXT_KEYED_CONDITIONS.includes(c))
      );
    })
    .map((r) => ({ reason: r.reason as string, action: r.action }));
}

export function checkDrift(
  opts: AuditOptions,
  symbionts: SymbiontContext[],
  promptSample = DEFAULT_PROMPT_SAMPLE,
): { findings: Finding[]; coverage: CoverageGap[] } {
  const findings: Finding[] = [];
  const coverage: CoverageGap[] = [];
  const registry = new SymbiontRegistry();

  for (const symbiont of symbionts) {
    if (opts.symbiont && symbiont.name !== opts.symbiont) continue;

    const declared = declaredPromptRules(symbiont.name);
    if (declared.length === 0) continue;

    const adapter = registry.getAdapter(symbiont.name);
    const discovery = manifestTranscriptDiscovery(symbiont.name);
    if (!adapter || !discovery) {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'rule drift',
        reason: `Declares ${declared.length} user_prompt rule(s) but has no transcript source to replay them over, so rot cannot be detected here.`,
      });
      continue;
    }

    const transcripts = enumerateTranscripts(discovery, 200);
    const matched = new Set<string>();
    let prompts = 0;

    for (const transcript of transcripts) {
      if (prompts >= promptSample) break;
      let content: string;
      try {
        if (fs.statSync(transcript.filePath).size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(transcript.filePath, 'utf8');
      } catch {
        continue;
      }

      let turns: ReturnType<typeof adapter.parseTurns>;
      try {
        turns = adapter.parseTurns(content);
      } catch {
        continue;
      }

      for (const turn of turns) {
        if (!turn.prompt) continue;
        if (prompts >= promptSample) break;
        prompts += 1;
        const decision = evaluateUserPromptRules(symbiont.name, {
          prompt: turn.prompt,
          transcriptPath: transcript.filePath,
        } as never);
        const reason = 'reason' in decision ? decision.reason : undefined;
        if (reason) matched.add(reason);
      }
    }

    if (prompts === 0) {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'rule drift',
        reason: 'No user prompts could be parsed from any transcript, so no rule could be exercised.',
      });
      continue;
    }

    const unmatched = declared.filter((rule) => !matched.has(rule.reason));
    if (unmatched.length > 0) {
      findings.push({
        id: 'manifest-rule-never-matched',
        layer: 'drift',
        severity: 'medium',
        title: `${symbiont.name}: declared capture rules that matched nothing`,
        detail:
          `Replayed ${prompts} prompt(s) from ${transcripts.length} transcript(s); these rules never fired. ` +
          'Most often the literal they key on was renamed upstream — the failure mode that let teammate reports leak as human prompts. ' +
          'A rule can also legitimately show zero if an earlier rule shadows it, if the situation did not occur in the sample, or if the parser already dropped the entries it keys on — replay runs over parsed turns, not raw entries. Confirm before editing.',
        count: unmatched.length,
        symbiont: symbiont.name,
        recency: 'unknown',
        samples: unmatched.map((r) => r.reason).slice(0, 5),
      });
    }
  }

  return { findings, coverage };
}
