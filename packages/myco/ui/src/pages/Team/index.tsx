import { useSearchParams } from 'react-router-dom';
import { Activity, RefreshCw, Users } from 'lucide-react';
import { useTeamStatus } from '../../hooks/use-team';
import { PageHeader } from '../../components/ui/page-header';
import { PageLoading } from '../../components/ui/page-loading';
import type { Tab } from '../../components/ui/tab-switcher';
import { StatusTab } from './StatusTab';
import { SyncTab } from './SyncTab';
import { MembersTab } from './MembersTab';
import { NotConnectedView } from './NotConnectedView';

type TabId = 'status' | 'sync' | 'members';

const TABS: Tab[] = [
  { id: 'status', label: 'Status', Icon: Activity },
  { id: 'sync', label: 'Sync', Icon: RefreshCw },
  { id: 'members', label: 'Members', Icon: Users },
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
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Team"
          subtitle="Grove-scoped team sync and membership"
          tabs={isConnected ? TABS : undefined}
          activeTab={isConnected ? tab : undefined}
          onTabChange={
            isConnected
              ? (id) => setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set('tab', id);
                  return next;
                }, { replace: true })
              : undefined
          }
        />
      </div>
      <div className="flex-1 overflow-auto">
        <div className="px-6 py-6">
          {!isConnected ? (
            <NotConnectedView scopeName={scopeName} />
          ) : tab === 'sync' ? (
            <SyncTab status={status} />
          ) : tab === 'members' ? (
            <MembersTab />
          ) : (
            <StatusTab status={status} />
          )}
        </div>
      </div>
    </div>
  );
}

export default TeamPage;
