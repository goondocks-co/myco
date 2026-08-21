/**
 * A hook's time budget, derived from its own declared harness timeout in the
 * generated hook config — the one source the installer's emitted timeouts and
 * this reader share. `hookBudget = timeout − 1 s`, `connectTimeout =
 * min(2 s, hookBudget/3)`, `requestTimeout = hookBudget/2`; the deadline
 * counts from process start, so hook startup is charged to the budget.
 */
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import {
  CONNECT_TIMEOUT_CAP_MS, HOOK_BUDGET_MARGIN_MS, MEMBER_DEFAULT_HOOK_TIMEOUT_MS, NEVER_DRAINS_HOOK, UNBOUNDED_REQUEST_TIMEOUT_MS,
} from './constants.js';

export interface RequestBudget {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface HookBudget extends RequestBudget {
  symbiont: string;
  hookName: string;
  /** The harness timeout the template declares for this hook, or null when undeclared. */
  declaredTimeoutMs: number | null;
  hookBudgetMs: number;
  /** Epoch ms after which no further request starts. */
  deadline: number;
  /** False for the hook that never drains (PreToolUse). */
  drains: boolean;
}

/** The template timeout (ms) for `(symbiont, hookName)`: by the harness event when known, else through the single-valued inverse index. */
export function declaredTimeoutMs(symbiont: string, hookName: string, hookEventName?: string): number | null {
  const events = HOOK_CONFIG[symbiont]?.hookEvents ?? {};
  if (hookEventName && events[hookEventName]?.hook === hookName) {
    const t = events[hookEventName].timeout;
    return t === undefined ? null : t * 1000;
  }
  for (const entry of Object.values(events)) {
    if (entry.hook === hookName) return entry.timeout === undefined ? null : entry.timeout * 1000;
  }
  return null;
}

/** The request budget the hook budget derives. */
export function requestBudgetFor(hookBudgetMs: number): RequestBudget {
  return {
    connectTimeoutMs: Math.max(1, Math.min(CONNECT_TIMEOUT_CAP_MS, Math.floor(hookBudgetMs / 3))),
    requestTimeoutMs: Math.max(1, Math.floor(hookBudgetMs / 2)),
  };
}

/** The budget for this hook process: from its declared timeout (or the default for an undeclared one), counted from process start. */
export function resolveHookBudget(
  symbiont: string,
  hookName: string,
  opts: { hookEventName?: string; startedAt?: number } = {},
): HookBudget {
  const declared = declaredTimeoutMs(symbiont, hookName, opts.hookEventName);
  const timeoutMs = declared ?? MEMBER_DEFAULT_HOOK_TIMEOUT_MS;
  const hookBudgetMs = Math.max(0, timeoutMs - HOOK_BUDGET_MARGIN_MS);
  const startedAt = opts.startedAt ?? Date.now() - Math.floor(process.uptime() * 1000);
  return {
    symbiont,
    hookName,
    declaredTimeoutMs: declared,
    hookBudgetMs,
    ...requestBudgetFor(hookBudgetMs),
    deadline: startedAt + hookBudgetMs,
    drains: hookName !== NEVER_DRAINS_HOOK,
  };
}

/** No harness deadline: `myco member drain` and the CLI commands. */
export function unboundedBudget(): HookBudget {
  return {
    symbiont: '',
    hookName: 'member',
    declaredTimeoutMs: null,
    hookBudgetMs: Number.POSITIVE_INFINITY,
    connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS,
    requestTimeoutMs: UNBOUNDED_REQUEST_TIMEOUT_MS,
    deadline: Number.POSITIVE_INFINITY,
    drains: true,
  };
}

/** Milliseconds left before the deadline. */
export function remainingMs(budget: HookBudget, now: number = Date.now()): number {
  return budget.deadline - now;
}

/** True while another request of `requestTimeoutMs` still fits before the deadline. */
export function canStartRequest(budget: HookBudget, now: number = Date.now()): boolean {
  return remainingMs(budget, now) >= budget.connectTimeoutMs;
}

/** The request budget clipped to what remains before the deadline. */
export function clippedRequestBudget(budget: HookBudget, now: number = Date.now()): RequestBudget {
  const remaining = remainingMs(budget, now);
  return {
    connectTimeoutMs: Math.max(1, Math.min(budget.connectTimeoutMs, remaining)),
    requestTimeoutMs: Math.max(1, Math.min(budget.requestTimeoutMs, remaining)),
  };
}
