import { Link } from 'react-router-dom';
import { StatusDot } from './status-dot';
import { useDaemon } from '../../hooks/use-daemon';
import { cn } from '../../lib/cn';

export function computeIndexingPct(described: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.floor((described / total) * 100);
}

export interface CortexStatusPillViewProps {
  describedCount: number | undefined;
  entriesCount: number | undefined;
  to?: string;
  className?: string;
}

export function CortexStatusPillView({
  describedCount,
  entriesCount,
  to,
  className,
}: CortexStatusPillViewProps) {
  const known = describedCount !== undefined && entriesCount !== undefined;
  const pct = known ? computeIndexingPct(describedCount, entriesCount) : null;
  const indexing = pct !== null && pct < 100;
  const content = (
    <>
      <StatusDot tone={indexing ? 'ochre' : 'sage'} pulse={indexing} />
      <span className="font-sans text-[10px] uppercase tracking-wider text-on-surface-variant">cortex</span>
      <span className="font-mono text-xs text-on-surface">{pct === null ? '—' : `${pct}%`}</span>
    </>
  );
  const classes = cn(
    'inline-flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 no-underline',
    to && 'hover:bg-surface-container-high transition-colors',
    className,
  );
  return to ? (
    <Link
      to={to}
      className={classes}
      title="Cortex (Canopy) describe coverage. Open Cortex."
    >
      {content}
    </Link>
  ) : (
    <div
      className={classes}
      title="Cortex (Canopy) describe coverage"
    >
      {content}
    </div>
  );
}

export function CortexStatusPill({ to, className }: { to?: string; className?: string }) {
  const { data } = useDaemon();
  return (
    <CortexStatusPillView
      describedCount={data?.canopy.described_count}
      entriesCount={data?.canopy.entries_count}
      to={to}
      className={className}
    />
  );
}
