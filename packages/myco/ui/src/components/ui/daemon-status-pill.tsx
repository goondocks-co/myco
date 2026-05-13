import { StatusDot } from './status-dot';
import { useDaemon } from '../../hooks/use-daemon';
import { cn } from '../../lib/cn';

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3_600);
    const m = Math.floor((seconds % 3_600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  return `${d}d ${h}h`;
}

export interface DaemonStatusPillViewProps {
  uptimeSeconds: number | undefined;
  className?: string;
}

export function DaemonStatusPillView({ uptimeSeconds, className }: DaemonStatusPillViewProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1',
        className,
      )}
      title="Daemon uptime"
    >
      <StatusDot tone="sage" />
      <span className="font-sans text-[10px] uppercase tracking-wider text-on-surface-variant">daemon</span>
      <span className="font-mono text-xs text-on-surface">
        {uptimeSeconds !== undefined ? formatUptime(uptimeSeconds) : '—'}
      </span>
    </div>
  );
}

export function DaemonStatusPill({ className }: { className?: string }) {
  const { data } = useDaemon();
  return <DaemonStatusPillView uptimeSeconds={data?.daemon.uptime_seconds} className={className} />;
}
