/**
 * Dumb, deterministic planning-intent detector for the prompt-submit nudge.
 *
 * Intentionally a fixed keyword set — NOT an LLM classifier. The moment this
 * needs tuning it becomes a maintenance treadmill, which is the trap the
 * tools-first plan strategy avoids. Word-bounded, case-insensitive.
 */
const PLAN_INTENT_PATTERN =
  /\b(plan|plans|planning|spec|specs|roadmap|milestone|milestones|phase|phases|design doc|implementation plan)\b/i;

export function detectsPlanIntent(prompt: string): boolean {
  return PLAN_INTENT_PATTERN.test(prompt);
}

/** One-sentence nudge injected at most once per session when intent is detected. */
export const PLAN_INTENT_NUDGE =
  'Myco is where plans live — persist and update them with `myco_plans` (op: "save", with `status` transitions), and pick up an existing plan in a new session by its ID with op: "get".';
