import type { ReactNode } from 'react';
import { Server } from 'lucide-react';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { healthBadgeVariant, humanizeHealthKind } from '../../lib/constants';
import { useHostServeStatus, type HostServeExternalMcpStatus } from '../../hooks/use-host-serve-status';

function externalMcpSummary(mcp: HostServeExternalMcpStatus): string {
  if (!mcp.enabled) return 'Off';
  const bound = mcp.bound === null ? 'bound state unknown' : mcp.bound ? 'bound' : 'not bound';
  const token = mcp.token_present ? 'token set' : 'token missing';
  return `On · port ${mcp.port} · ${bound} · ${token}`;
}

function Stat({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="font-sans text-[11px] uppercase tracking-wider text-on-surface-variant">{label}</dt>
      <dd className={cn('mt-0.5 text-sm text-on-surface', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

function HealthStat({ label, kind }: { label: string; kind: string }) {
  return (
    <div>
      <dt className="font-sans text-[11px] uppercase tracking-wider text-on-surface-variant">{label}</dt>
      <dd className="mt-0.5">
        <Badge variant={healthBadgeVariant(kind)}>{humanizeHealthKind(kind)}</Badge>
      </dd>
    </div>
  );
}

/**
 * Machine Dashboard operator card for this machine's own Team Host serving
 * state (E-4 W1 Task T6, decision-ef693c71 D2: serving is machine-tier, so
 * this unconditional card lives here rather than on any one Grove — the
 * Grove Dashboard's conditional counterpart is `TeamHostServedCard`).
 * Renders nothing for the large majority of machines that never serve;
 * see `useHostServeStatus` for the polling behavior this null render
 * pairs with.
 */
export function TeamHostServingCard() {
  const { data } = useHostServeStatus();
  if (!data || data.serving !== true) return null;

  const {
    served_grove_id: servedGroveId,
    served_grove_name: servedGroveName,
    overlay_address: overlayAddress,
    host_id: hostId,
    label,
    hosted_project_count: hostedProjectCount,
    external_mcp: externalMcp,
    bearer_present: bearerPresent,
    health,
  } = data;

  // The one case this card must NOT hide: the daemon booted serving a Grove
  // that a freshly loaded config no longer designates, or that no longer
  // exists on this machine. `resolveServedGroveDesignationHealth` re-reads
  // disk on every request, so this can only diverge from the boot-resolved
  // runtime after an on-disk edit since boot. Serving stays visually "on"
  // (the runtime object is real and still enforced by this process) but
  // the header badge and this hint say so honestly.
  const configDrifted = health.designation === 'not_serving' || health.designation === 'dangling';

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <SectionHeader>Team Host</SectionHeader>
        <Badge variant={configDrifted ? 'destructive' : 'default'}>
          {configDrifted ? 'Needs attention' : 'Serving'}
        </Badge>
      </div>

      {configDrifted && (
        <p className="font-sans text-xs text-secondary m-0">
          Restart the daemon to apply the team storage change made on disk.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Stat
          label="Team storage"
          value={
            <span className="inline-flex flex-wrap items-center gap-2">
              {servedGroveName ?? '—'}
              <Badge variant={healthBadgeVariant(health.designation)}>
                {humanizeHealthKind(health.designation)}
              </Badge>
            </span>
          }
        />
        <Stat label="Team storage ID" value={servedGroveId ?? '—'} mono />
        <Stat label="Overlay address" value={overlayAddress} mono />
        <Stat
          label="Host"
          value={
            <>
              {label ?? '—'}
              {hostId && <div className="font-mono text-xs text-on-surface-variant">{hostId}</div>}
            </>
          }
        />
        <Stat label="Hosted projects" value={hostedProjectCount} />
        <Stat label="Bearer token" value={bearerPresent ? 'Set' : 'Missing'} />
        <Stat
          label="External access"
          value={
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge variant={healthBadgeVariant(health.mcp_coherence)}>
                {humanizeHealthKind(health.mcp_coherence)}
              </Badge>
              <span className="text-xs text-on-surface-variant">{externalMcpSummary(externalMcp)}</span>
            </span>
          }
        />
        <HealthStat label="Backups" kind={health.backup} />
        <HealthStat label="Provider key" kind={health.key} />
      </dl>
    </Surface>
  );
}
