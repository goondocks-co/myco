import { useDaemon } from '../hooks/use-daemon';
import { PageLoading } from '../components/ui/page-loading';
import { DataFlow } from '../components/dashboard/DataFlow';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';
import { CuratorStatus } from '../components/dashboard/CuratorStatus';
import { EmbeddingHealth } from '../components/dashboard/EmbeddingHealth';

export default function Dashboard() {
  const { data: stats, isLoading, isError, error } = useDaemon();

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Connecting to daemon..."
    >
      {stats && (
        <div className="space-y-6 p-6">
          <DataFlow stats={stats} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ActivityFeed />
            </div>
            <div className="space-y-4">
              <CuratorStatus />
              <EmbeddingHealth />
            </div>
          </div>
        </div>
      )}
    </PageLoading>
  );
}
