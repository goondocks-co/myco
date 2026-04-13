/** Shared helpers for mycelium (spore/entity) components. */

/** Tailwind class string for observation type badges — uses design system tokens only.
 *  primary (sage) = knowledge/growth, secondary (ochre) = deliberate/neutral, tertiary (terracotta) = warnings/problems */
export function observationTypeClass(type: string): string {
  switch (type) {
    case 'wisdom':     return 'bg-primary/15 text-primary';
    case 'discovery':  return 'bg-primary/15 text-primary';
    case 'decision':   return 'bg-secondary/15 text-secondary';
    case 'trade_off':  return 'bg-secondary/15 text-secondary';
    case 'gotcha':     return 'bg-tertiary/15 text-tertiary';
    case 'bug_fix':    return 'bg-tertiary/15 text-tertiary';
    default:           return 'bg-surface-container text-on-surface-variant';
  }
}

/** Tailwind class string for spore status badges — uses design system tokens only. */
export function statusClass(status: string): string {
  switch (status) {
    case 'active':       return 'bg-primary/15 text-primary';
    case 'consolidated': return 'bg-surface-container-high text-on-surface-variant';
    case 'superseded':   return 'bg-tertiary/10 text-tertiary/70';
    default:             return 'bg-surface-container text-on-surface-variant';
  }
}

/** Format a snake_case or kebab-case value as a Title Case label. */
export function formatLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
