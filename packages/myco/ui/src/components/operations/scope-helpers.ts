/**
 * Scope chip + helper-text strings used by Operations sections.
 *
 * Each Operations panel is bound to one of these data scopes; the chip and
 * helper line make it explicit so users can tell at a glance which slice of
 * the multi-tenant daemon a panel covers (Grove DB / project / all-Groves).
 */

export type SectionScope = 'grove' | 'all-groves' | 'project';

export const SCOPE_HELPER_TEXT: Record<SectionScope, string> = {
  grove:
    'Aggregated for this Grove. Switch projects via the upper-left switcher to view a different Grove.',
  'all-groves': 'Aggregates every Grove on this machine.',
  project: 'Filtered to the active project.',
};
