/** Shared helpers for mycelium (spore/entity) components. */

/** Tailwind class string for observation type badges (no borders — tonal surfaces). */
export function observationTypeClass(type: string): string {
  switch (type) {
    case 'gotcha':     return 'bg-orange-500/15 text-orange-600 dark:text-orange-400';
    case 'decision':   return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    case 'discovery':  return 'bg-purple-500/15 text-purple-600 dark:text-purple-400';
    case 'trade_off':  return 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400';
    case 'bug_fix':    return 'bg-red-500/15 text-red-600 dark:text-red-400';
    default:           return 'bg-surface-container text-on-surface-variant';
  }
}

/** Tailwind class string for spore status badges (no borders — tonal surfaces). */
export function statusClass(status: string): string {
  switch (status) {
    case 'active':       return 'bg-green-500/15 text-green-700 dark:text-green-400';
    case 'superseded':   return 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400';
    case 'consolidated': return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    default:             return 'bg-surface-container text-on-surface-variant';
  }
}

/** Format a snake_case or kebab-case value as a Title Case label. */
export function formatLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
