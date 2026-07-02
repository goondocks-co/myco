/**
 * Harness-neutral lifecycle hooks.
 *
 * Closes Gap 4 from the April 2026 harness maturity audit
 * (spore_11b6645a205e0a455f247a122cddbb0d): observability was entirely
 * post-hoc via agent_turns/agent_reports DB queries. These four hook
 * points let a caller (or the default audit-event recorder in
 * audit-hooks.ts) observe tool calls and phase boundaries as they happen,
 * regardless of which harness (claude-sdk, openai-agents) is executing.
 *
 * See docs/superpowers/specs/2026-07-01-harness-hook-system-design.md
 * for the full design rationale, including why these are void-returning
 * observability hooks and NOT a permission-decision mechanism (that stays
 * on the existing readOnlyHint/dry-run structural gates — see design
 * spec §6).
 */

import type { HarnessId } from '@myco/agent/types.js';

/** Identifies which harness-level construct a tool call or phase belongs to. */
export interface HarnessHookContext {
  runId: string;
  agentId: string;
  harnessId: HarnessId;
  /** Present for phase-scoped calls; absent for orchestrator/single-query calls. */
  phaseName?: string;
}

export interface PreToolUseEvent extends HarnessHookContext {
  toolName: string;
  toolInput: unknown;
}

export interface PostToolUseEvent extends HarnessHookContext {
  toolName: string;
  toolInput: unknown;
  outcome: 'success' | 'error';
  /** Present only when outcome === 'error'. */
  errorMessage?: string;
  durationMs: number;
}

export interface PhaseStartEvent extends HarnessHookContext {
  phaseName: string;
  model: string;
  maxTurns?: number;
  required: boolean;
}

export interface PhaseEndEvent extends HarnessHookContext {
  phaseName: string;
  status: 'completed' | 'failed' | 'skipped';
  turnsUsed: number;
  tokensUsed: number;
  costUsd: number | null;
  durationMs: number;
}

/**
 * Harness-neutral lifecycle hooks. All fields optional — a caller registers
 * only the events it cares about. Each callback is awaited in-line by the
 * emission site, around the tool call (preToolUse/postToolUse) or phase
 * boundary (phaseStart/phaseEnd) it observes — a slow implementation
 * delays the tool result or phase transition, so implementations must be
 * fast and non-blocking internally. Failures (sync throws or rejected
 * promises) are caught and swallowed at the emission site: they never
 * propagate to the caller and never fail the tool call. The void return
 * type reflects that these are observability hooks, not a permission
 * decision mechanism.
 */
export interface HarnessHooks {
  preToolUse?(event: PreToolUseEvent): void | Promise<void>;
  postToolUse?(event: PostToolUseEvent): void | Promise<void>;
  phaseStart?(event: PhaseStartEvent): void | Promise<void>;
  phaseEnd?(event: PhaseEndEvent): void | Promise<void>;
}
