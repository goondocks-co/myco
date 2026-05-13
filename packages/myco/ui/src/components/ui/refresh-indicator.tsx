import { RefreshCw } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface RefreshIndicatorProps {
  intervalMs?: number;
  isFetching: boolean;
  onManualRefresh: () => void;
  /** Reserved for a future "updated Xs ago" label. Not currently rendered. */
  lastUpdatedAt?: number | null;
  className?: string;
}

function formatInterval(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function RefreshIndicator({
  intervalMs,
  isFetching,
  onManualRefresh,
  lastUpdatedAt: _lastUpdatedAt,
  className,
}: RefreshIndicatorProps) {
  const label = intervalMs !== undefined ? formatInterval(intervalMs) : null;
  return (
    <div
      className={cn('flex items-center gap-2 text-on-surface-variant', className)}
      aria-busy={isFetching}
    >
      <span
        data-testid="refresh-indicator-dot"
        className={cn(
          'h-1.5 w-1.5 rounded-full bg-primary',
          isFetching && 'animate-pulse',
        )}
        aria-hidden
      />
      {label ? (
        <span className="font-sans text-xs">every {label}</span>
      ) : null}
      <button
        type="button"
        onClick={onManualRefresh}
        aria-label="Refresh now"
        className="rounded-md p-1 hover:bg-surface-container-high hover:text-on-surface transition-colors"
      >
        <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
      </button>
    </div>
  );
}
