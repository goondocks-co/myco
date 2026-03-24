/** Shared helpers for agent run components. */

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

/** Format the duration between two epoch-second timestamps. */
export function formatDuration(startEpoch: number | null, endEpoch: number | null): string {
  if (startEpoch === null || endEpoch === null) return '\u2014';
  const ms = (endEpoch - startEpoch) * 1000;
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
