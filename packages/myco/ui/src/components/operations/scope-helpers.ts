/**
 * Scope chip + helper-text strings used by Operations sections.
 *
 * Each Operations panel is bound to one of these data scopes; the chip and
 * helper line make it explicit so users can tell at a glance which slice of
 * the multi-tenant daemon a panel covers (Grove DB / project / all-Groves).
 */

import type { ProjectSelection } from '../../lib/selection';
import type { OperationsScope } from './OperationsScopePill';

export type SectionScope = 'grove' | 'all-groves' | 'project';

export const SCOPE_HELPER_TEXT: Record<SectionScope, string> = {
  grove:
    'Aggregated for this Grove. Switch projects via the upper-left switcher to view a different Grove.',
  'all-groves': 'Aggregates every Grove on this machine.',
  project: 'Filtered to the active project.',
};

export const OPERATIONS_SCOPE_HELPER_TEXT: Record<OperationsScope, string> = {
  project: 'Action targets the active project only.',
  grove: 'Action targets every project in this Grove.',
  'all-groves': 'Action targets every Grove on this machine.',
};

/**
 * Wire-format scope envelope sent in action POST bodies. P7 owns the
 * server-side validation; absent or unknown values currently fall through
 * to the request's header-bound Grove/project context.
 */
export type ActionScope =
  | { kind: 'project'; grove_id: string; project_id: string }
  | { kind: 'grove'; grove_id: string }
  | { kind: 'all-groves' };

export function buildActionScope(
  scope: OperationsScope,
  selection: ProjectSelection | null,
): ActionScope | undefined {
  if (scope === 'all-groves') return { kind: 'all-groves' };
  if (!selection) return undefined;
  if (scope === 'grove') return { kind: 'grove', grove_id: selection.grove.id };
  return {
    kind: 'project',
    grove_id: selection.grove.id,
    project_id: selection.project.project_id,
  };
}
