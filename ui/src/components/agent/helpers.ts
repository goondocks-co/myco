/** Shared helpers for agent run components. */

import { TASK_SOURCE_USER } from '../../lib/constants';

/** Tailwind class string for run status badges (legacy — prefer Badge variant). */
export function runStatusClass(status: string): string {
  switch (status) {
    case 'completed': return 'bg-primary-container/20 text-primary';
    case 'failed':    return 'bg-tertiary-container/20 text-tertiary';
    case 'running':   return 'bg-secondary-container/20 text-secondary';
    default:          return 'bg-surface-container-high text-on-surface-variant';
  }
}

/** Format a USD cost value for display. */
export function formatCost(cost: number | null): string {
  if (cost === null) return '\u2014';
  return `$${cost.toFixed(4)}`;
}

/** Format a token count for display. */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return '\u2014';
  return tokens.toLocaleString();
}

// formatDuration re-exported from the shared format library.
export { formatDuration } from '../../lib/format';

/** Badge classes for task source (built-in vs user). */
export function taskSourceClass(source: string): string {
  return source === TASK_SOURCE_USER
    ? 'bg-secondary-container/20 text-secondary'
    : 'bg-surface-container-high text-on-surface-variant';
}
