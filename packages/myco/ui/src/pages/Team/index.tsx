/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The Team page (E1 §5, rev 6) — machine-scoped at `/team`.
 *
 * UNCONNECTED (not hosting, no joined hosts): the FORK and only the fork —
 * "Host a team" and "Join a team", nothing else mounts. The product
 * principle this encodes (Chris): the first thing a user does is become a
 * host or join one; until then nothing else on the page matters. The old
 * eleven-panel stack mounted the settings section unconnected, whose very
 * first fetch 404'd `not_serving` and rendered an error banner as the
 * page's DEFAULT state.
 *
 * CONNECTED: three tabs rebuilt around hosts-as-teams (frame recovered from
 * a0c40006):
 *   - Team (machine-scoped): serving card + membership + attach + delivery
 *   - External access (host-scoped): promoted from the page bottom
 *   - Settings (host-scoped): full member editors, E-0 routed-write model
 *
 * Host-scoped tabs use the page's OWN selector (never the project selector
 * — session 2b5a68a1), targeting hosts BY HOST ID (`x-myco-host-id`,
 * PR #802): a joined host with zero attached projects is a first-class
 * target. Selection + tab live in the URL (`?tab=`/`?team=`) so views are
 * linkable and survive the enable flow's mid-run page reload.
 */
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/page-header';
import { PageContainer } from '../../components/ui/page-container';
import { SubtabPill } from '../../components/ui/subtab-pill';
import { TeamHostServingCard } from '../../components/operations/TeamHostServingCard';
import { ExternalAccessPanel } from '../../components/team/ExternalAccessPanel';
import { TeamSettingsPanel } from '../../components/team/TeamSettingsPanel';
import { DisableHostControl, MemberAccessControl, MintJoinKeyControl } from '../../components/team/ServingControls';
import type { TeamConfigTarget } from '../../hooks/use-scoped-config';
import { useHostMembershipStatus } from '../../hooks/use-host-membership';
import { useHostServeStatus } from '../../hooks/use-host-serve-status';
import { HostATeamPanel } from './HostATeamPanel';
import { HostTab, JoinHostForm } from './HostTab';

const TAB_IDS = ['team', 'external', 'settings'] as const;
type TabId = typeof TAB_IDS[number];
// External access is refused by the daemon off macOS/Linux (Unix-socket +
// Funnel activation): a live toggle that can only 502 is a lying switch, so
// the TAB disappears when the daemon says the capability is absent.
// `!== false` keeps older daemons (field absent) rendering as before.
function tabItems(externalMcpSupported: boolean) {
  return [
    { id: 'team', label: 'Team' },
    ...(externalMcpSupported ? [{ id: 'external', label: 'External access' }] : []),
    { id: 'settings', label: 'Settings' },
  ];
}

const SELF_TARGET_ID = 'self';
const LAST_TEAM_TARGET_KEY = 'myco.teamPage.lastTarget';

interface HostTargetOption { id: string; label: string; target: TeamConfigTarget; }

export function TeamPage() {
  const membership = useHostMembershipStatus();
  const serve = useHostServeStatus();
  const [params, setParams] = useSearchParams();

  const hosts = membership.data?.hosts ?? [];
  const serving = serve.data?.serving === true;
  const externalMcpSupported = membership.data?.external_mcp_supported !== false;
  // The fork renders only once both reads have SETTLED as disconnected —
  // flashing the fork at a connected user (or vice versa) reads as data loss.
  const settled = membership.data !== undefined && serve.data !== undefined;
  const connected = hosts.length > 0 || serving;

  // Host-scoped tab targets: "This machine" first when serving (this box
  // configures its own served grove with no carrier — resolved server-side
  // from hostServe.servedGroveId), then every joined host BY HOST ID —
  // including hosts with zero attached projects.
  const targetOptions = useMemo<HostTargetOption[]>(() => {
    const options: HostTargetOption[] = [];
    if (serving) options.push({ id: SELF_TARGET_ID, label: 'This machine', target: { carrier: null } });
    for (const host of hosts) {
      options.push({ id: host.host_id, label: `${host.label} (${host.host_id})`, target: { carrier: { hostId: host.host_id } } });
    }
    return options;
  }, [serving, hosts]);

  // Selection precedence: URL → localStorage → first (old select-default.ts).
  const tabParam = params.get('tab');
  const tabIds: readonly string[] = externalMcpSupported ? TAB_IDS : ['team', 'settings'];
  const tab: TabId = tabIds.includes(tabParam ?? '') ? (tabParam as TabId) : 'team';
  const teamParam = params.get('team');
  const stored = (() => { try { return localStorage.getItem(LAST_TEAM_TARGET_KEY); } catch { return null; } })();
  const selectedTarget = targetOptions.find((o) => o.id === teamParam)
    ?? targetOptions.find((o) => o.id === stored)
    ?? targetOptions[0]
    ?? null;

  const selectedTargetId = selectedTarget?.id;
  useEffect(() => {
    if (selectedTargetId) {
      try { localStorage.setItem(LAST_TEAM_TARGET_KEY, selectedTargetId); } catch { /* private mode */ }
    }
  }, [selectedTargetId]);

  const setTab = (next: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', next);
    setParams(nextParams, { replace: true });
  };
  const setTarget = (id: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('team', id);
    setParams(nextParams, { replace: true });
  };

  if (!settled) {
    // Never a causeless forever-Loading (review C6): a cold-start failure of
    // either read names itself — same principle as the External panel's
    // loud status error.
    const loadError = membership.error ?? serve.error;
    return (
      <PageContainer>
        <PageHeader
          title="Team"
          subtitle={loadError ? `Could not load team state: ${loadError instanceof Error ? loadError.message : String(loadError)}` : 'Loading…'}
        />
      </PageContainer>
    );
  }

  if (!connected) {
    // THE FORK — and only the fork. No settings mount, no team-config
    // fetch, no default-state error banner, by construction (E1 §5.1).
    return (
      <PageContainer>
        <PageHeader
          title="Team"
          subtitle="Share your team's knowledge from one always-on host. Host a team on this machine, or join one a teammate already hosts."
        />
        <div className="grid gap-4 lg:grid-cols-2" data-testid="team-fork">
          <HostATeamPanel />
          <JoinHostForm />
        </div>
      </PageContainer>
    );
  }

  const hostScoped = tab !== 'team';
  return (
    <PageContainer>
      <PageHeader title="Team" subtitle="Your team's hosts, membership, and shared settings." />
      <div className="mb-4 flex flex-wrap items-center gap-3" data-testid="team-connected">
        <SubtabPill tabs={tabItems(externalMcpSupported)} activeTab={tab} onTabChange={setTab} />
        {/* The machine-scoped tab hides the selector; host-scoped tabs
            require it (the scope rule for these tabs). */}
        {hostScoped && targetOptions.length > 0 && (
          <select
            aria-label="Configure team for"
            className="ml-auto rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface"
            value={selectedTarget?.id ?? ''}
            onChange={(e) => setTarget(e.target.value)}
            data-testid="team-target-select"
          >
            {targetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
      </div>

      {tab === 'team' && (
        <div className="flex flex-col gap-4">
          <TeamHostServingCard actions={<><MintJoinKeyControl /><MemberAccessControl /><DisableHostControl /></>} />
          <HostTab />
          {/* "Add another" affordances — the fork panels collapsed (§5.2). */}
          <div className="flex flex-wrap gap-2">
            <JoinHostForm collapsed />
            {!serving && <HostATeamPanel collapsed />}
          </div>
        </div>
      )}
      {/* Remount on target change — the reused forms hold local draft state
          keyed to whatever grove they last loaded; a fresh mount avoids a
          stale draft bleeding across hosts. */}
      {tab === 'external' && selectedTarget && (
        <ExternalAccessPanel key={selectedTarget.id} target={selectedTarget.target} />
      )}
      {tab === 'settings' && selectedTarget && (
        <TeamSettingsPanel key={selectedTarget.id} target={selectedTarget.target} />
      )}
    </PageContainer>
  );
}

export default TeamPage;
