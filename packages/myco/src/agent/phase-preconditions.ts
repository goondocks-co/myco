/**
 * Mechanical per-phase preCondition checks.
 *
 * Each check is deterministic SQL — no LLM turns. The phase loop runs the
 * check before composing the prompt; on false the phase is recorded as
 * `skipped` and the harness is not invoked. This is the "mechanical
 * pre-filter before LLM spend" pattern (see the `tune-agent-task-cost`
 * skill) applied at the phase boundary.
 *
 * Adding a new kind: add one entry to `PHASE_PRECONDITIONS` below. The
 * type, the Zod enum (via PHASE_PRECONDITION_KINDS export), and the
 * runtime dispatch are all driven from this single source.
 */

import {
  countConsolidatableSporesInProjectSince,
  countSporesInProjectSince,
} from '@myco/db/queries/spores.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import { PHASE_PRECONDITION_KINDS, type PhasePreConditionKind } from './phase-precondition-kinds.js';

export { PHASE_PRECONDITION_KINDS, type PhasePreConditionKind };

/**
 * Window (in seconds) for `has-recent-spore-activity` and
 * `has-recent-consolidatable-spores` — counts spores created in the
 * trailing 24 hours. Sized so a project with no recent curation
 * activity skips dependent phases, but a project with even a single
 * user session that produced spores still runs them.
 */
export const RECENT_SPORE_ACTIVITY_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Minimum count of qualifying spores in the activity window required
 * for either spore-activity preCondition to pass. Three is the floor
 * for any kind of clustering ("3+ related spores" is the wisdom-creation
 * rule), so dropping below it means even the best case has nothing to
 * consolidate.
 */
export const RECENT_SPORE_ACTIVITY_MIN_COUNT = 3;

export interface PhasePreConditionResult {
  passed: boolean;
  /** Human-readable reason — surfaced on the skipped PhaseResult summary. */
  reason: string;
}

type PhasePreConditionFn = (scope: ProjectScope) => PhasePreConditionResult;

const PHASE_PRECONDITIONS: Record<PhasePreConditionKind, PhasePreConditionFn> = {
  'has-recent-spore-activity': (scope) => {
    const since = Math.floor(Date.now() / 1000) - RECENT_SPORE_ACTIVITY_WINDOW_SECONDS;
    const count = countSporesInProjectSince(scope, since);
    const passed = count >= RECENT_SPORE_ACTIVITY_MIN_COUNT;
    return {
      passed,
      reason: passed
        ? `${count} active spores in last 24h`
        : `Only ${count} active spores in last 24h (need ≥${RECENT_SPORE_ACTIVITY_MIN_COUNT})`,
    };
  },
  'has-recent-consolidatable-spores': (scope) => {
    // Tighter than has-recent-spore-activity: counts only spores the
    // consolidate LLM phase can actually act on — active, non-wisdom
    // (can't consolidate wisdoms into more wisdom), AND embedded
    // (semantic search can't return un-embedded rows). Filters out the
    // common no-op case where extract just created spores that haven't
    // been embedded yet — the LLM would search, find nothing, and SKIP
    // after burning $0.07–0.10. This gate makes that decision in zero
    // LLM turns.
    const since = Math.floor(Date.now() / 1000) - RECENT_SPORE_ACTIVITY_WINDOW_SECONDS;
    const count = countConsolidatableSporesInProjectSince(scope, since);
    const passed = count >= RECENT_SPORE_ACTIVITY_MIN_COUNT;
    return {
      passed,
      reason: passed
        ? `${count} consolidatable spores in last 24h (active, non-wisdom, embedded)`
        : `Only ${count} consolidatable spores in last 24h (need ≥${RECENT_SPORE_ACTIVITY_MIN_COUNT} active, non-wisdom, embedded)`,
    };
  },
};

export function checkPhasePreCondition(
  kind: PhasePreConditionKind,
  scope: ProjectScope,
): PhasePreConditionResult {
  const fn = PHASE_PRECONDITIONS[kind];
  if (!fn) {
    // The type system makes this unreachable for typed callers; the guard
    // catches runtime callers (e.g. YAML deserialization) that pre-date a
    // kind being added or removed.
    throw new Error(`Unknown phase preCondition kind: ${String(kind)}`);
  }
  return fn(scope);
}
