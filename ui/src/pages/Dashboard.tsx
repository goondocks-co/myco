import { useDaemon } from '../hooks/use-daemon';
import { PageLoading } from '../components/ui/page-loading';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';

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
          <ActivityFeed />
        </div>
      )}
    </PageLoading>
  );
}
