import { useSearchParams } from 'react-router-dom';
import { Activity, RefreshCw, Users, Network } from 'lucide-react';
import { useTeamStatus } from '../../hooks/use-team';
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

export function TeamPage() {
  const { data: status, isLoading } = useTeamStatus();
  const [params, setParams] = useSearchParams();
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
    if (tab === 'sync') return <SyncTab status={status!} />;
    if (tab === 'members') return <MembersTab />;
    return <StatusTab status={status!} />;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Team"
        subtitle="Grove-scoped team sync and membership"
      />
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
