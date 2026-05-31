import { useSearchParams } from 'react-router-dom';
import { Activity, RefreshCw, Users, Network, AlertTriangle } from 'lucide-react';
import { useTeamStatus, useTeamRegistry, type TeamStatusResponse } from '../../hooks/use-team';
import { AccentSurface } from '../../components/ui/accent-surface';
import { PageHeader } from '../../components/ui/page-header';
import { PageLoading } from '../../components/ui/page-loading';
import { PageContainer } from '../../components/ui/page-container';
import { TileTabs } from '../../components/ui/tile-tabs';
import { TeamSelection } from './TeamSelection';
import { StatusTab } from './StatusTab';
import { SyncTab } from './SyncTab';
import { MembersTab } from './MembersTab';
import { NotConnectedView } from './NotConnectedView';

type TabId = 'teams' | 'status' | 'sync' | 'members';

const TABS = [
  { id: 'teams', label: 'Teams', description: 'select projects', Icon: Network },
  { id: 'status', label: 'Status', description: 'identity + health', Icon: Activity },
  { id: 'sync', label: 'Sync', description: 'queue + secrets', Icon: RefreshCw },
  { id: 'members', label: 'Members', description: 'roster', Icon: Users },
];

const VALID_TABS = new Set<TabId>(['teams', 'status', 'sync', 'members']);

/**
 * Sync pauses when this daemon's sync protocol is incompatible with the team
 * worker (the daemon skips draining rather than churning doomed pushes). Surface
 * it page-wide with the actionable fix — the block affects every tab, not just
 * Status. `ok`/`unknown` render nothing.
 */
function VersionBlockBanner({ status }: { status: TeamStatusResponse }) {
  if (status.version_status !== 'client_too_old' && status.version_status !== 'worker_too_old') {
    return null;
  }
  const clientTooOld = status.version_status === 'client_too_old';
  const heading = clientTooOld
    ? 'Sync paused — this machine is out of date'
    : 'Sync paused — the team worker is out of date';
  const command = clientTooOld
    ? 'myco update'
    : `myco-team update --team-id ${status.team_id ?? '<team_id>'}`;
  const detail = clientTooOld
    ? `This daemon speaks sync protocol v${status.daemon_protocol_version}, but the team worker requires at least v${status.worker_min_client_version ?? '?'}.`
    : `This daemon speaks sync protocol v${status.daemon_protocol_version}, but the team worker only supports up to v${status.worker_protocol_version ?? '?'}.`;
  return (
    <AccentSurface accent="terra" padded className="mb-4 flex items-start gap-3" role="alert">
      <AlertTriangle className="size-5 shrink-0 text-terracotta-text" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-medium text-on-surface">{heading}</p>
        <p className="m-0 text-sm text-on-surface-variant">
          {detail} Pending changes are held safely; run <code className="text-terracotta-text">{command}</code> to resume syncing.
        </p>
      </div>
    </AccentSurface>
  );
}

export function TeamPage() {
  const [params, setParams] = useSearchParams();
  const { data: registry } = useTeamRegistry();
  const teams = registry?.teams ?? [];
  const selectedTeamId = params.get('team') ?? teams[0]?.team_id ?? undefined;
  const { data: status, isLoading } = useTeamStatus(selectedTeamId);
  const raw = params.get('tab') ?? 'teams';
  const tab: TabId = VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'teams';

  if (isLoading) {
    return (
      <PageLoading isLoading error={null} loadingText="Loading team…">
        <span />
      </PageLoading>
    );
  }
  if (!status) return null;

  const isConnected = status.enabled && status.worker_url;
  const scopeName = status.grove?.name ?? status.project.name ?? 'this Grove';

  function renderTab() {
    // The Teams selection tab is always available — it manages registry
    // membership independent of the legacy per-Grove connection.
    if (tab === 'teams') return <TeamSelection />;
    if (!isConnected) return <NotConnectedView scopeName={scopeName} />;
    if (tab === 'sync') return <SyncTab status={status!} teamId={selectedTeamId} />;
    if (tab === 'members') return <MembersTab teamId={selectedTeamId} />;
    return <StatusTab status={status!} />;
  }

  // Team scope selector lives in the header's right slot (not above the tabs)
  // so toggling it across tabs never shifts the tab row or content — the
  // header height is driven by the title/subtitle. Hidden on the Teams tab,
  // which is machine-scoped (manages all teams), not scoped to one team.
  const teamScopeSelector = teams.length > 0 && tab !== 'teams' ? (
    <>
      <label htmlFor="team-scope" className="myco-eyebrow-sm text-on-surface-variant">Team</label>
      <select
        id="team-scope"
        aria-label="Selected team"
        className="rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface"
        value={selectedTeamId ?? ''}
        onChange={(e) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('team', e.target.value);
            return next;
          }, { replace: true })
        }
      >
        {teams.map((t) => (
          <option key={t.team_id} value={t.team_id}>{t.name}</option>
        ))}
      </select>
    </>
  ) : undefined;

  return (
    <PageContainer>
      <PageHeader
        title="Team"
        subtitle="Sync your projects to shared team clouds"
        actions={teamScopeSelector}
      />
      <VersionBlockBanner status={status} />
      <TileTabs
        tabs={TABS}
        activeTab={tab}
        onTabChange={(id) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set('tab', id);
              return next;
            },
            { replace: true },
          )
        }
        columns={4}
      />
      {renderTab()}
    </PageContainer>
  );
}

export default TeamPage;
