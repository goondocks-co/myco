/** Shared helpers for agent run components. */

import { TASK_SOURCE_USER } from '../../lib/constants';
import type { TaskRow } from '../../hooks/use-agent';

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

/** Map run/phase status to Badge variant. */
export function statusBadgeVariant(status: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed': return 'default';
    case 'running':   return 'warning';
    case 'failed':    return 'destructive';
    default:          return 'secondary';
  }
}

/** Map task source to Badge variant. */
export function sourceBadgeVariant(source: string | undefined): 'warning' | 'secondary' {
  return source === TASK_SOURCE_USER ? 'warning' : 'secondary';
}

/** Fallback label when no task name is available. */
export const UNKNOWN_TASK_LABEL = 'Default task';

/** Resolve a task name to its display name using a task list. */
export function resolveTaskName(taskName: string | null, tasks: TaskRow[]): string {
  if (!taskName) return UNKNOWN_TASK_LABEL;
  const found = tasks.find((t) => t.name === taskName);
  return found?.displayName ?? taskName;
}
