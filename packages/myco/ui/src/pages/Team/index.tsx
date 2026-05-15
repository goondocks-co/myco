import { useSearchParams } from 'react-router-dom';
import { Activity, RefreshCw, Users } from 'lucide-react';
import { useTeamStatus } from '../../hooks/use-team';
import { PageHeader } from '../../components/ui/page-header';
import { PageLoading } from '../../components/ui/page-loading';
import { StatusTab } from './StatusTab';
import { SyncTab } from './SyncTab';
import { MembersTab } from './MembersTab';
import { NotConnectedView } from './NotConnectedView';

type TabId = 'status' | 'sync' | 'members';

const TABS: { id: TabId; label: string; Icon: typeof Activity }[] = [
  { id: 'status', label: 'Status', Icon: Activity },
  { id: 'sync', label: 'Sync', Icon: RefreshCw },
  { id: 'members', label: 'Members', Icon: Users },
];

export function TeamPage() {
  const { data: status, isLoading } = useTeamStatus();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabId) ?? 'status';

  if (isLoading) return <PageLoading isLoading error={null}><span /></PageLoading>;
  if (!status) return null;

  const isConnected = status.enabled && status.worker_url;
  const scopeName = status.grove?.name ?? status.project.name ?? 'this Grove';

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader title="Team" subtitle="Grove-scoped team sync and membership" />
        {isConnected && (
          <div className="mt-4 flex gap-1 border-b border-outline-variant/20">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setParams({ tab: id })}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === id
                    ? 'border-primary text-on-surface'
                    : 'border-transparent text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        )}
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
