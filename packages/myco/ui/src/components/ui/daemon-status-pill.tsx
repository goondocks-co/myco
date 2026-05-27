import { Link } from 'react-router-dom';
import { StatusDot } from './status-dot';
import { useDaemon } from '../../hooks/use-daemon';
import { useUpdateStatus } from '../../hooks/use-update-status';
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
  version?: string;
  updateAvailable?: boolean;
  latestVersion?: string;
  to?: string;
  className?: string;
}

function formatVersionLabel(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

export function DaemonStatusPillView({
  uptimeSeconds,
  version,
  updateAvailable = false,
  latestVersion,
  to,
  className,
}: DaemonStatusPillViewProps) {
  const title = updateAvailable && latestVersion
    ? `Daemon uptime · update available: ${formatVersionLabel(latestVersion)}`
    : version
      ? `Daemon uptime · ${formatVersionLabel(version)}`
      : 'Daemon uptime';
  const content = (
    <>
      <StatusDot tone={updateAvailable ? 'ochre' : 'sage'} pulse={updateAvailable} />
      <span className="font-sans text-[10px] uppercase tracking-wider text-on-surface-variant">daemon</span>
      <span className="font-mono text-xs text-on-surface">
        {uptimeSeconds !== undefined ? formatUptime(uptimeSeconds) : '—'}
      </span>
      {version && (
        <>
          <span aria-hidden className="text-on-surface-variant">·</span>
          <span className="font-mono text-xs text-on-surface-variant">{formatVersionLabel(version)}</span>
        </>
      )}
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
      title={`${title}. Open update settings.`}
      aria-live="polite"
    >
      {content}
    </Link>
  ) : (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1',
        className,
      )}
      title={title}
      aria-live="polite"
    >
      {content}
    </div>
  );
}

export function DaemonStatusPill({ to, className }: { to?: string; className?: string }) {
  const { data } = useDaemon();
  const updateStatus = useUpdateStatus();
  const updateAvailable = Boolean(
    updateStatus.data
    && !updateStatus.data.exempt
    && (updateStatus.data.update_available || updateStatus.data.revert_available),
  );
  return (
    <DaemonStatusPillView
      uptimeSeconds={data?.daemon.uptime_seconds}
      version={data?.daemon.version_label ?? data?.daemon.version}
      updateAvailable={updateAvailable}
      latestVersion={updateStatus.data?.latest_version}
      to={to}
      className={className}
    />
  );
}
