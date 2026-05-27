/**
 * Mechanical per-phase preCondition checks.
 *
 * Each check is deterministic SQL — no LLM turns. The phase loop runs the
 * check before composing the prompt; on false the phase is recorded as
 * `skipped` and the harness is not invoked. This is the "mechanical
 * pre-filter before LLM spend" pattern (see the `tune-agent-task-cost`
 * skill) applied at the phase boundary.
 *
 * Adding a new kind: add to `PhasePreConditionKind` in types.ts, mirror
 * in `PhasePreConditionSchema` in schemas.ts, register the check here.
 */

import { countSporesInProjectSince } from '@myco/db/queries/spores.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import type { PhasePreConditionKind } from './types.js';

/**
 * Window (in seconds) for `has-recent-spore-activity` — counts spores
 * created in the trailing 24 hours. Sized so a project with no recent
 * curation activity skips consolidation work, but a project with even
 * a single user session that produced spores still runs the phase.
 */
export const RECENT_SPORE_ACTIVITY_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Minimum count of active spores in the activity window required for
 * `has-recent-spore-activity` to pass. Three is the floor for any kind
 * of clustering ("3+ related spores" is the wisdom-creation rule), so
 * dropping below it means even the best case has nothing to consolidate.
 */
export const RECENT_SPORE_ACTIVITY_MIN_COUNT = 3;

export interface PhasePreConditionResult {
  passed: boolean;
  /** Human-readable reason — surfaced on the skipped PhaseResult summary. */
  reason: string;
}

export function checkPhasePreCondition(
  kind: PhasePreConditionKind,
  scope: ProjectScope,
): PhasePreConditionResult {
  switch (kind) {
    case 'has-recent-spore-activity': {
      const since = Math.floor(Date.now() / 1000) - RECENT_SPORE_ACTIVITY_WINDOW_SECONDS;
      const count = countSporesInProjectSince(scope, since);
      const passed = count >= RECENT_SPORE_ACTIVITY_MIN_COUNT;
      return {
        passed,
        reason: passed
          ? `${count} active spores in last 24h`
          : `Only ${count} active spores in last 24h (need ≥${RECENT_SPORE_ACTIVITY_MIN_COUNT})`,
      };
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown phase preCondition kind: ${String(exhaustive)}`);
    }
  }
}
