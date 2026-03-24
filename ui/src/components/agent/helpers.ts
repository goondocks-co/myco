/** Shared helpers for agent run components. */

import { TASK_SOURCE_USER } from '../../lib/constants';

/** Tailwind class string for run status badges. */
export function runStatusClass(status: string): string {
  switch (status) {
    case 'completed': return 'bg-green-500/15 text-green-700 border-green-500/30 dark:text-green-400';
    case 'failed':    return 'bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400';
    case 'running':   return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400';
    default:          return 'bg-muted text-muted-foreground border-border';
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
    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
    : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
}

/** Format phase count for display. */
export function formatPhaseCount(config: string | null | undefined): string {
  if (!config) return 'Single query';
  try {
    const parsed = JSON.parse(config);
    const phases = parsed?.phases;
    if (!Array.isArray(phases) || phases.length === 0) return 'Single query';
    return `${phases.length} phases`;
  } catch {
    return 'Single query';
  }
}
