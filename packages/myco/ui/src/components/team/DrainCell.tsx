import { cn } from '../../lib/cn';
import type { DrainCounters } from '../../hooks/use-host-membership';

/**
 * One drain's pending/failing counters (consolidation Task C-5's status
 * API). Shared by the all-hosts `DrainHealthPanel` (`pages/Team/HostTab.tsx`)
 * and the per-host breakdown in the host detail slideout
 * (`HostDetailPanel.tsx`) — both read the SAME `useDrainHealth()` poll, this
 * renders whichever host's `drains` object either one hands it.
 */
export function DrainCell({ label, counters }: { label: string; counters: DrainCounters | undefined }) {
  if (!counters) return null;
  const failing = counters.failing_entries > 0;
  const sized = counters.pending_bytes !== undefined
    ? `${counters.pending_bytes.toLocaleString()} bytes`
    : counters.pending_records !== undefined
      ? `${counters.pending_records.toLocaleString()} records`
      : undefined;
  return (
    <div className={cn('flex flex-col gap-0.5 rounded px-2 py-1', failing ? 'bg-terracotta/10' : 'bg-surface-container')}>
      <span className="myco-eyebrow-sm text-on-surface-variant">{label}</span>
      <span className="text-xs text-on-surface">
        {counters.pending_entries} pending{sized !== undefined ? ` (${sized})` : ''}
        {failing ? ` · ${counters.failing_entries} failing` : ''}
      </span>
    </div>
  );
}
