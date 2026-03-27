import { useRef, useEffect, memo } from 'react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { levelDotColor, levelBadgeVariant } from '../../lib/constants';
import { formatTimeAgo } from '../../lib/format';
import type { LogEntry } from '../../hooks/use-logs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVEL_BORDER_LEFT: Record<string, string> = {
  debug: 'border-l-outline/30',
  info: 'border-l-primary/50',
  warn: 'border-l-secondary/70',
  error: 'border-l-tertiary/80',
};

const COMPONENT_COLOR: Record<string, string> = {
  context: 'text-primary/70',
  hooks: 'text-on-surface-variant/70',
  agent: 'text-secondary/80',
  daemon: 'text-on-surface-variant/60',
  capture: 'text-primary/60',
  processor: 'text-on-surface-variant/70',
  lifecycle: 'text-primary/50',
  embedding: 'text-on-surface-variant/60',
  power: 'text-on-surface-variant/50',
  server: 'text-on-surface-variant/60',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string, relative: boolean): string {
  if (relative) return formatTimeAgo(iso);
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LogTableProps {
  entries: LogEntry[];
  selectedId: number | null;
  onSelect: (entry: LogEntry) => void;
  autoScroll?: boolean;
  relativeTime?: boolean;
  compact?: boolean;
}

export function LogTable({
  entries,
  selectedId,
  onSelect,
  autoScroll = false,
  relativeTime = false,
  compact = true,
}: LogTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, autoScroll]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-surface-container-lowest font-mono text-xs"
    >
      {entries.length === 0 ? (
        <div className="flex h-full min-h-[200px] items-center justify-center text-on-surface-variant/50 font-sans text-sm">
          No log entries
        </div>
      ) : (
        <table className="w-full border-collapse" aria-label="Log entries">
          <tbody>
            {entries.map((entry) => (
              <LogRow
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedId}
                onSelect={onSelect}
                relativeTime={relativeTime}
                compact={compact}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

const LogRow = memo(function LogRow({
  entry,
  selected,
  onSelect,
  relativeTime,
  compact,
}: {
  entry: LogEntry;
  selected: boolean;
  onSelect: (entry: LogEntry) => void;
  relativeTime: boolean;
  compact: boolean;
}) {
  const py = compact ? 'py-0.5' : 'py-1.5';

  return (
    <tr
      className={cn(
        'cursor-pointer transition-colors border-l-2',
        LEVEL_BORDER_LEFT[entry.level],
        selected
          ? 'bg-primary/10'
          : 'hover:bg-surface-container-high/30',
      )}
      onClick={() => onSelect(entry)}
    >
      <td className={cn('whitespace-nowrap pl-3 pr-2 text-on-surface-variant/50 align-top w-[68px] tabular-nums', py)}>
        {formatTimestamp(entry.timestamp, relativeTime)}
      </td>
      <td className={cn('whitespace-nowrap pr-1 align-top w-[12px]', py)}>
        <div className={cn('h-1.5 w-1.5 rounded-full mt-1', levelDotColor(entry.level as 'debug' | 'info' | 'warn' | 'error'))} />
      </td>
      <td className={cn('whitespace-nowrap pr-2 align-top w-[48px]', py)}>
        <Badge
          variant={levelBadgeVariant(entry.level as 'debug' | 'info' | 'warn' | 'error')}
          className="px-1 py-0 text-[9px] uppercase"
        >
          {entry.level}
        </Badge>
      </td>
      <td className={cn('whitespace-nowrap pr-2 align-top w-[90px] truncate max-w-[90px]', py, COMPONENT_COLOR[entry.component] ?? 'text-on-surface-variant/60')}>
        {entry.component}
      </td>
      <td className={cn('pr-3 text-on-surface align-top break-words', py)}>
        {entry.message}
      </td>
    </tr>
  );
});
