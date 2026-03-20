import { useDaemon } from '../hooks/use-daemon';
import { MycoTopology } from '../components/topology/MycoTopology';
import { Card, CardContent } from '../components/ui/card';
import { PageLoading } from '../components/ui/page-loading';
import { QuickActions } from '../components/dashboard/quick-actions';
import {
  DaemonCard,
  VaultCard,
  SporesCard,
  IndexCard,
  DigestCard,
  IntelligenceCard,
} from '../components/dashboard/stat-cards';

export default function Dashboard() {
  const { data: stats, isLoading, isError, error } = useDaemon();

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Connecting to daemon..."
    >
      {stats && (
        <div className="flex flex-col gap-6 p-6">
          {/* Topology visualization */}
          <Card className="overflow-hidden">
            <CardContent className="p-4">
              <MycoTopology stats={stats} />
            </CardContent>
          </Card>

          {/* Quick actions */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Quick Actions
            </h2>
            <QuickActions stats={stats} />
          </section>

          {/* Stats cards grid */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              System Status
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DaemonCard stats={stats} />
              <VaultCard stats={stats} />
              <SporesCard stats={stats} />
              <IndexCard stats={stats} />
              <DigestCard stats={stats} />
              <IntelligenceCard stats={stats} />
            </div>
          </section>
        </div>
      )}
    </PageLoading>
  );
}
