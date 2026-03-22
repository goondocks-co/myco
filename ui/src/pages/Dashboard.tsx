import { useDaemon } from '../hooks/use-daemon';
import { PipelineVisualization } from '../components/pipeline/PipelineVisualization';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { PageLoading } from '../components/ui/page-loading';
import { Activity } from 'lucide-react';
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
          {/* Pipeline health — the live processing state */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="h-4 w-4 text-primary" />
                Pipeline Health
              </CardTitle>
            </CardHeader>
            <CardContent>
              <PipelineVisualization />
            </CardContent>
          </Card>

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
