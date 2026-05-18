import { useSearchParams } from 'react-router-dom';
import { Activity, RefreshCw, Users } from 'lucide-react';
import { useTeamStatus } from '../../hooks/use-team';
import { PageHeader } from '../../components/ui/page-header';
import { PageLoading } from '../../components/ui/page-loading';
import { PageContainer } from '../../components/ui/page-container';
import { TileTabs } from '../../components/ui/tile-tabs';
import { StatusTab } from './StatusTab';
import { SyncTab } from './SyncTab';
import { MembersTab } from './MembersTab';
import { NotConnectedView } from './NotConnectedView';

type TabId = 'status' | 'sync' | 'members';

const TABS = [
  { id: 'status', label: 'Status', description: 'identity + health', Icon: Activity },
  { id: 'sync', label: 'Sync', description: 'queue + secrets', Icon: RefreshCw },
  { id: 'members', label: 'Members', description: 'roster', Icon: Users },
];

const VALID_TABS = new Set<TabId>(['status', 'sync', 'members']);

export function TeamPage() {
  const { data: status, isLoading } = useTeamStatus();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'status';
  const tab: TabId = VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'status';

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

  return (
    <PageContainer>
      <PageHeader
        title="Team"
        subtitle="Grove-scoped team sync and membership"
      />
      {isConnected && (
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
          columns={3}
        />
      )}
      {!isConnected ? (
        <NotConnectedView scopeName={scopeName} />
      ) : tab === 'sync' ? (
        <SyncTab status={status} />
      ) : tab === 'members' ? (
        <MembersTab />
      ) : (
        <StatusTab status={status} />
      )}
    </PageContainer>
  );
}

export default TeamPage;
