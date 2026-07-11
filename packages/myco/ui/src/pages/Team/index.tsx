import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, RefreshCw, Users, Network, AlertTriangle } from 'lucide-react';
import { useTeamStatus, useTeamRegistry, type TeamStatusResponse } from '../../hooks/use-team';
import { AccentSurface } from '../../components/ui/accent-surface';
import { PageHeader } from '../../components/ui/page-header';
import { PageLoading } from '../../components/ui/page-loading';
import { PageContainer } from '../../components/ui/page-container';
import { TileTabs } from '../../components/ui/tile-tabs';
import { Eyebrow } from '../../components/ui/eyebrow';
import { HostTab } from './HostTab';
import { TeamSelection } from './TeamSelection';
import { StatusTab } from './StatusTab';
import { SyncTab } from './SyncTab';
import { MembersTab } from './MembersTab';
import { NotConnectedView } from './NotConnectedView';
import { SelectTeamView } from './SelectTeamView';
import { resolveDefaultSelectedTeamId } from './select-default';

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

/**
 * Partial degradation companion to VersionBlockBanner: the worker accepts
 * this daemon (sync is NOT paused) but its deployment predates some synced
 * tables, so the reconcile pass skips them until the worker updates. Warns
 * (ochre) rather than alerts, with the same actionable worker-update
 * command. Renders nothing when the worker is current — and yields to the
 * hard-block banner, which owns the page when sync is fully paused.
 */
function PartialSyncBanner({ status }: { status: TeamStatusResponse }) {
  const gated = status.reconcile_gated_tables ?? [];
  if (gated.length === 0) return null;
  if (status.version_status === 'client_too_old' || status.version_status === 'worker_too_old') {
    return null;
  }
  const command = `myco-team update --team-id ${status.team_id ?? '<team_id>'}`;
  return (
    <AccentSurface accent="ochre" padded className="mb-4 flex items-start gap-3" role="status">
      <AlertTriangle className="size-5 shrink-0 text-ochre" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-medium text-on-surface">Partial sync — the team worker is behind this daemon</p>
        <p className="m-0 text-sm text-on-surface-variant">
          Not reconciling: <code className="text-ochre">{gated.join(', ')}</code> (worker protocol
          v{status.worker_protocol_version ?? '?'}, daemon v{status.daemon_protocol_version}). Local
          data is held safely; run <code className="text-ochre">{command}</code> to resume full sync.
        </p>
      </div>
    </AccentSurface>
  );
}

const TEAM_SELECTION_KEY = 'myco.team.selectedTeamId';

/**
 * Page transition (consolidation Task D-2): Team Host membership (join,
 * per-project attach, drain health — `HostTab`) is now the PRIMARY content,
 * unconditional. The legacy TEAM SYNC flow this replaces (SelectTeamView /
 * TeamSelection / MembersTab against the cloud worker) demotes to a
 * clearly-marked "Legacy" section BELOW it, visible only when team sync is
 * already configured on this machine (`teams.length > 0`) — a machine with
 * no team-sync history gets no "join a team" onboarding funnel here anymore,
 * so there is never more than one "join" story competing for attention. The
 * legacy section is scheduled for removal in E-2.
 */
export function TeamPage() {
  const [params, setParams] = useSearchParams();
  const { data: registry, isLoading: registryLoading } = useTeamRegistry();
  const teams = registry?.teams ?? [];
  const legacyConfigured = teams.length > 0;
  const storedTeamId = typeof window !== 'undefined'
    ? window.localStorage.getItem(TEAM_SELECTION_KEY)
    : null;
  const selectedTeamId = resolveDefaultSelectedTeamId(params.get('team'), teams, storedTeamId);

  // Persist the resolved selection (including the auto-selected first team) so it
  // survives tab navigation and revisits within the Team section.
  useEffect(() => {
    if (selectedTeamId && selectedTeamId !== storedTeamId) {
      window.localStorage.setItem(TEAM_SELECTION_KEY, selectedTeamId);
    }
  }, [selectedTeamId, storedTeamId]);
  // Only fetched once legacy team sync is actually configured — Team Host's
  // primary content never depends on this cloud-worker round trip.
  const { data: status, isLoading: statusLoading } = useTeamStatus(
    registryLoading || !legacyConfigured ? undefined : selectedTeamId,
  );
  const raw = params.get('tab') ?? 'teams';
  const tab: TabId = VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'teams';

  // A fast, machine-local read (the registry, not the cloud worker) — brief
  // enough to gate the whole page so the legacy section doesn't visibly pop
  // in a beat after Team Host renders.
  if (registryLoading) {
    return (
      <PageLoading isLoading error={null} loadingText="Loading team…">
        <span />
      </PageLoading>
    );
  }

  const isConnected = Boolean(status?.enabled && status?.worker_url);
  const scopeName = status?.grove?.name ?? status?.project.name ?? 'this Grove';

  function renderLegacyTab() {
    // The Teams selection tab is always available — it manages registry
    // membership independent of the legacy per-Grove connection.
    if (tab === 'teams') return <TeamSelection />;
    // A team is auto-selected when any exist; this only renders when no teams are
    // registered yet — point the user to the Teams tab to join one.
    if (!selectedTeamId) return <SelectTeamView hasTeams={teams.length > 0} />;
    if (statusLoading || !status) {
      return (
        <PageLoading isLoading error={null} loadingText="Loading team…">
          <span />
        </PageLoading>
      );
    }
    if (!isConnected) return <NotConnectedView scopeName={scopeName} />;
    if (tab === 'sync') return <SyncTab status={status} teamId={selectedTeamId} />;
    if (tab === 'members') return <MembersTab teamId={selectedTeamId} />;
    return <StatusTab status={status} />;
  }

  // Team scope selector lives beside the legacy section's own tab row (not
  // the page header) — it selects among legacy TEAM SYNC teams, a concern
  // scoped to that demoted subsection now, not the whole page. Hidden on the
  // Teams tab, which is machine-scoped (manages all teams), not scoped to one.
  const teamScopeSelector = tab !== 'teams' ? (
    <>
      <label htmlFor="team-scope" className="myco-eyebrow-sm text-on-surface-variant">Team</label>
      <select
        id="team-scope"
        aria-label="Selected team"
        className="rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface"
        value={selectedTeamId ?? ''}
        onChange={(e) => {
          window.localStorage.setItem(TEAM_SELECTION_KEY, e.target.value);
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('team', e.target.value);
            return next;
          }, { replace: true });
        }}
      >
        {!selectedTeamId && <option value="" disabled>Select a team…</option>}
        {teams.map((t) => (
          <option key={t.team_id} value={t.team_id}>{t.name}</option>
        ))}
      </select>
    </>
  ) : undefined;

  return (
    <PageContainer>
      <PageHeader title="Team" subtitle="Route projects to a shared Team Host" />
      <HostTab />
      {legacyConfigured && (
        <div className="mt-8 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 border-t border-outline-variant/20 pt-6">
            <div className="flex items-center gap-2">
              <Eyebrow tone="outline" size="sm">Legacy</Eyebrow>
              <h2 className="myco-display-sm text-on-surface-variant m-0">Team Sync</h2>
            </div>
            <div className="flex items-center gap-2">{teamScopeSelector}</div>
          </div>
          {status && <VersionBlockBanner status={status} />}
          {status && <PartialSyncBanner status={status} />}
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
          {renderLegacyTab()}
        </div>
      )}
    </PageContainer>
  );
}

export default TeamPage;
