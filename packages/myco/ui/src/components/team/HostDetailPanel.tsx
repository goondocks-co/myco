import { CheckCircle2, HelpCircle, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Panel } from '../ui/panel';
import { Badge, type BadgeProps } from '../ui/badge';
import { DefRow } from '../ui/def-row';
import { DrainCell } from './DrainCell';
import { LeaveHostControl } from './LeaveHostControl';
import { useDrainHealth, useHostMembershipHealth, type HostMembershipHost } from '../../hooks/use-host-membership';
import { useGroves } from '../../hooks/use-groves';
import {
  HOST_DETAIL_NO_PROJECTS_COPY,
  HOST_REACHABILITY_COPY,
  protocolSkewNote,
  type HostReachabilityDisplayState,
} from '../../lib/membership-copy';

const REACHABILITY_ICON: Record<HostReachabilityDisplayState, typeof CheckCircle2> = {
  checking: Loader2,
  reachable: CheckCircle2,
  unreachable: XCircle,
  not_confirmable: HelpCircle,
};

const REACHABILITY_BADGE_VARIANT: Record<HostReachabilityDisplayState, BadgeProps['variant']> = {
  checking: 'outline',
  reachable: 'default',
  unreachable: 'destructive',
  not_confirmable: 'secondary',
};

function reachabilityDisplayState(isLoading: boolean, reachable: boolean | null | undefined): HostReachabilityDisplayState {
  if (isLoading) return 'checking';
  if (reachable === true) return 'reachable';
  if (reachable === false) return 'unreachable';
  return 'not_confirmable';
}

export interface HostDetailPanelProps {
  host: HostMembershipHost;
}

/**
 * Host detail slideout content (E-4 W1 Task T5) — rendered inside
 * `SlideoutDetailPanel` by `HostTab`, mounted ONLY while a host is selected.
 * That mount/unmount lifecycle is what gates the live health query below:
 * `SlideoutDetailPanel` unmounts its children entirely on close, so there is
 * no separate open/closed prop to thread through — the query simply stops
 * existing when this component does (decision-ef693c71 D3: never a
 * background poll).
 */
export function HostDetailPanel({ host }: HostDetailPanelProps) {
  const health = useHostMembershipHealth(true);
  const drain = useDrainHealth();
  // includeArchived: an attach ref's `local_grove_id` can name a local Grove
  // that's since been archived (still exists, just hidden from the default
  // Groves list) — excluding it here would render the raw grove id instead
  // of its name under "Shows under:" for an otherwise-normal attached ref.
  const groves = useGroves({ includeArchived: true });

  const healthEntry = health.data?.hosts.find((h) => h.host_id === host.host_id);
  const reachability = reachabilityDisplayState(health.isLoading, healthEntry?.reachable);
  const ReachabilityIcon = REACHABILITY_ICON[reachability];
  const skewNote = healthEntry ? protocolSkewNote(healthEntry.protocol_skew) : null;

  const drainHost = drain.data?.hosts.find((h) => h.host_id === host.host_id);
  const groveNameById = new Map((groves.data?.groves ?? []).map((g) => [g.id, g.name]));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="myco-display-sm text-on-surface m-0">{host.label}</h2>
        <p className="text-xs font-mono text-on-surface-variant break-all m-0 mt-1">{host.host_id}</p>
      </div>

      <Panel tone="sage" title="Identity">
        <dl className="flex flex-col gap-1.5 m-0">
          <DefRow term="Overlay address">{host.overlay_address}</DefRow>
          <DefRow term="Joined">{new Date(host.created_at).toLocaleDateString()}</DefRow>
        </dl>
      </Panel>

      <Panel tone="sage" title="Protocol">
        <dl className="flex flex-col gap-1.5 m-0">
          <DefRow term="Protocol version">{host.protocol_version}</DefRow>
        </dl>
        {skewNote && (
          <p className="flex items-start gap-1 text-xs text-ochre mt-2 mb-0" role="status" data-testid="host-detail-skew-note">
            {skewNote}
          </p>
        )}
      </Panel>

      <Panel
        tone="sage"
        title="Reachability"
        actions={
          <button
            type="button"
            onClick={() => health.refetch()}
            disabled={health.isFetching}
            className="text-xs text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            <RefreshCw className={health.isFetching ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} aria-hidden />
            Check now
          </button>
        }
      >
        <Badge variant={REACHABILITY_BADGE_VARIANT[reachability]} className="inline-flex items-center gap-1">
          <ReachabilityIcon className={reachability === 'checking' ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} aria-hidden />
          {HOST_REACHABILITY_COPY[reachability]}
        </Badge>
      </Panel>

      <Panel tone="sage" title="Capture delivery">
        {drainHost ? (
          <div className="grid grid-cols-3 gap-2">
            <DrainCell label="Transcript" counters={drainHost.drains.transcript} />
            <DrainCell label="Plan" counters={drainHost.drains.plan} />
            <DrainCell label="Live events" counters={drainHost.drains.event_replay} />
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant m-0">Nothing to report yet.</p>
        )}
      </Panel>

      <Panel tone="sage" title={`${host.projects.length} attached project${host.projects.length === 1 ? '' : 's'}`}>
        {host.projects.length === 0 ? (
          <p className="text-sm text-on-surface-variant m-0">{HOST_DETAIL_NO_PROJECTS_COPY}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {host.projects.map((ref) => (
              <div key={ref.project_id} className="rounded-md border border-[var(--ghost-border)] px-3 py-2">
                <div className="text-xs font-mono text-on-surface truncate" title={ref.root ?? undefined}>
                  {ref.project_id}
                </div>
                <div className="text-xs text-on-surface-variant truncate">
                  {ref.root ?? '—'}
                </div>
                <div className="text-xs text-on-surface-variant">
                  Shows under: {(ref.local_grove_id && groveNameById.get(ref.local_grove_id)) ?? ref.local_grove_id ?? '—'}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <LeaveHostControl host={host} />
    </div>
  );
}
