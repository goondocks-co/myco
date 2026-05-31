/**
 * Dumb, deterministic planning-intent detector + the prompt-submit nudge it
 * gates.
 *
 * The detector is intentionally a fixed keyword set — NOT an LLM classifier.
 * The moment it needs tuning it becomes a maintenance treadmill, which is the
 * trap the tools-first plan strategy avoids. Word-bounded, case-insensitive.
 */
import { recordInjectionAndShouldSuppress } from '../injection-records.js';

const PLAN_INTENT_PATTERN =
  /\b(plan|plans|planning|spec|specs|roadmap|milestone|milestones|phase|phases|design doc|implementation plan)\b/i;

export function detectsPlanIntent(prompt: string): boolean {
  return PLAN_INTENT_PATTERN.test(prompt);
}

/** One-sentence nudge injected at most once per session when intent is detected. */
export const PLAN_INTENT_NUDGE =
  'Myco is where plans live — persist and update them with `myco_plans` (op: "save", with `status` transitions), and pick up an existing plan in a new session by its ID with op: "get".';

/**
 * Resolve the plan-intent nudge text for a prompt, or '' when it should not
 * fire. Owns the entire nudge concern (toggle, intent heuristic, per-session
 * dedup) so the prompt-context handler can treat it as one opaque contributor
 * rather than interleaving nudge logic with spore search. Best-effort: a
 * dedup/record failure returns '' and never propagates — the prompt response
 * must never break because of the nudge.
 */
export async function resolvePlanIntentNudge(opts: {
  enabled: boolean;
  prompt: string;
  sessionId: string | null | undefined;
  projectId: string | null;
}): Promise<string> {
  if (!opts.enabled || !opts.sessionId || !detectsPlanIntent(opts.prompt)) return '';
  try {
    const { suppress } = await recordInjectionAndShouldSuppress({
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      injectionType: 'plan-nudge',
      trigger: { metadata: {} },
      fetchContent: async () => ({ text: PLAN_INTENT_NUDGE, metadata: {} }),
    });
    return suppress ? '' : PLAN_INTENT_NUDGE;
  } catch {
    return '';
  }
}
