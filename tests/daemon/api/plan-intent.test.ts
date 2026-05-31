import { describe, expect, it } from 'bun:test';
import { detectsPlanIntent, PLAN_INTENT_NUDGE, resolvePlanIntentNudge } from '@myco/daemon/api/plan-intent.js';

describe('detectsPlanIntent', () => {
  it('matches explicit planning language', () => {
    expect(detectsPlanIntent('Can you plan out the migration?')).toBe(true);
    expect(detectsPlanIntent('Let us write a spec for this')).toBe(true);
    expect(detectsPlanIntent('outline the implementation roadmap')).toBe(true);
  });

  it('does not match unrelated prompts', () => {
    expect(detectsPlanIntent('fix the failing test in foo.ts')).toBe(false);
    expect(detectsPlanIntent('what does this function return?')).toBe(false);
  });

  it('is case-insensitive and word-bounded (no substring false positives)', () => {
    expect(detectsPlanIntent('PLAN the rollout')).toBe(true);
    expect(detectsPlanIntent('the airplane landed')).toBe(false); // "plane" != "plan"
  });

  it('exposes a single-sentence nudge string', () => {
    expect(PLAN_INTENT_NUDGE.length).toBeGreaterThan(0);
    expect(PLAN_INTENT_NUDGE).toContain('myco_plans');
  });
});

describe('resolvePlanIntentNudge — gating (no DB)', () => {
  // These paths short-circuit before any injection-record DB call.
  it('returns empty when disabled', async () => {
    expect(await resolvePlanIntentNudge({ enabled: false, prompt: 'plan it', sessionId: 's', projectId: null })).toBe('');
  });

  it('returns empty when the prompt has no planning intent', async () => {
    expect(await resolvePlanIntentNudge({ enabled: true, prompt: 'fix the bug', sessionId: 's', projectId: null })).toBe('');
  });

  it('returns empty when there is no calling session id', async () => {
    expect(await resolvePlanIntentNudge({ enabled: true, prompt: 'plan it', sessionId: null, projectId: null })).toBe('');
  });
});
