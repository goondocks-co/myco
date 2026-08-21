/**
 * The hook budget derives from the generated hook config — the one source the
 * emitted timeouts share — and PreToolUse never drains.
 */
import { describe, expect, it } from 'bun:test';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { canStartRequest, clippedRequestBudget, declaredTimeoutMs, remainingMs, resolveHookBudget, unboundedBudget } from '@myco/member/budget.js';
import { CONNECT_TIMEOUT_CAP_MS, HOOK_BUDGET_MARGIN_MS, MEMBER_DEFAULT_HOOK_TIMEOUT_MS, NEVER_DRAINS_HOOK } from '@myco/member/constants.js';

describe('hook budget', () => {
  it('derives hookBudget = timeout − 1 s, connect = min(2 s, budget/3), request = budget/2 from the generated config', () => {
    const stop = resolveHookBudget('claude-code', 'stop', { hookEventName: 'Stop', startedAt: 1_000 });
    expect(stop).toMatchObject({ declaredTimeoutMs: 30_000, hookBudgetMs: 29_000, connectTimeoutMs: 2_000, requestTimeoutMs: 14_500, deadline: 30_000, drains: true });
    const ups = resolveHookBudget('claude-code', 'user-prompt-submit', { startedAt: 0 });
    expect(ups).toMatchObject({ declaredTimeoutMs: 5_000, hookBudgetMs: 4_000, connectTimeoutMs: 1_333, requestTimeoutMs: 2_000, deadline: 4_000 });
    expect(HOOK_BUDGET_MARGIN_MS).toBe(1_000);
    expect(CONNECT_TIMEOUT_CAP_MS).toBe(2_000);
  });

  it('reads the timeout by harness event when the input names one and by the inverse index otherwise', () => {
    expect(declaredTimeoutMs('claude-code', 'session-end', 'SessionEnd')).toBe(10_000);
    expect(declaredTimeoutMs('claude-code', 'session-end')).toBe(10_000);
    // A harness event naming another hook does not answer for this one.
    expect(declaredTimeoutMs('claude-code', 'session-end', 'Stop')).toBe(10_000);
    expect(declaredTimeoutMs('nonexistent', 'stop')).toBeNull();
  });

  it('every claude-code hook has exactly one timeout, and the budget reads it', () => {
    const byHook = new Map<string, number | undefined>();
    for (const entry of Object.values(HOOK_CONFIG['claude-code'].hookEvents)) {
      if (byHook.has(entry.hook)) expect(byHook.get(entry.hook)).toBe(entry.timeout);
      byHook.set(entry.hook, entry.timeout);
    }
    for (const [hook, timeout] of byHook) {
      expect(resolveHookBudget('claude-code', hook).declaredTimeoutMs).toBe(timeout === undefined ? null : timeout * 1000);
    }
  });

  it('an undeclared timeout (windsurf) falls back to the default and PreToolUse never drains', () => {
    expect(HOOK_CONFIG.windsurf.hookEvents.post_cascade_response.timeout).toBeUndefined();
    const w = resolveHookBudget('windsurf', 'stop', { hookEventName: 'post_cascade_response' });
    expect(w.declaredTimeoutMs).toBeNull();
    expect(w.hookBudgetMs).toBe(MEMBER_DEFAULT_HOOK_TIMEOUT_MS - HOOK_BUDGET_MARGIN_MS);
    expect(resolveHookBudget('claude-code', NEVER_DRAINS_HOOK).drains).toBe(false);
    expect(NEVER_DRAINS_HOOK).toBe('pre-tool-use');
  });

  it('clips requests to the remaining time and stops starting them near the deadline', () => {
    const b = resolveHookBudget('claude-code', 'stop', { startedAt: 0 });
    expect(remainingMs(b, 28_000)).toBe(1_000);
    expect(canStartRequest(b, 26_000)).toBe(true);
    expect(canStartRequest(b, 28_500)).toBe(false);
    expect(clippedRequestBudget(b, 28_000)).toEqual({ connectTimeoutMs: 1_000, requestTimeoutMs: 1_000 });
    expect(clippedRequestBudget(b, 0)).toEqual({ connectTimeoutMs: 2_000, requestTimeoutMs: 14_500 });
    const u = unboundedBudget();
    expect(u.deadline).toBe(Number.POSITIVE_INFINITY);
    expect(canStartRequest(u, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
