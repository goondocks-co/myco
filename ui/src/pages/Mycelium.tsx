import {
  Network,
  RefreshCw,
  Sparkles,
  Brain,
  Clock,
  ShieldAlert,
  ListTodo,
} from 'lucide-react';
import { useDaemon } from '../hooks/use-daemon';
import { PipelineVisualization } from '../components/pipeline/PipelineVisualization';
import { WorkItemList } from '../components/pipeline/WorkItemList';
import { CircuitBreakerPanel } from '../components/pipeline/CircuitBreakerPanel';
import { DigestHealthPanel } from '../components/pipeline/DigestHealthPanel';
import { OperationButton } from '../components/operations/OperationButton';
import { CurationPanel } from '../components/operations/CurationPanel';
import { ReprocessPanel } from '../components/operations/ReprocessPanel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { PageLoading } from '../components/ui/page-loading';

/* ---------- Mycelium Page ---------- */

export default function Mycelium() {
  const { data: stats, isLoading, isError, error } = useDaemon();

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Connecting to daemon..."
    >
      {stats && (
        <div className="flex flex-col gap-6 p-6">
          {/* Page header */}
          <div>
            <div className="flex items-center gap-3">
              <Network className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-semibold">Mycelium</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Pipeline integrity and processing health
            </p>
          </div>

          {/* Pipeline visualization */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Pipeline Flow</CardTitle>
              <CardDescription>
                Live status of items progressing through the processing pipeline.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PipelineVisualization />
            </CardContent>
          </Card>

          {/* Digest health + Circuit breakers side by side */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Brain className="h-4 w-4 text-primary" />
                  Digest
                </CardTitle>
                <CardDescription>
                  Substrate accumulation, metabolism state, and cycle activity.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DigestHealthPanel />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldAlert className="h-4 w-4 text-primary" />
                  Circuit Breakers
                </CardTitle>
                <CardDescription>
                  Per-provider circuit breaker state and controls. Reset open circuits to resume processing.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CircuitBreakerPanel />
              </CardContent>
            </Card>
          </div>

          {/* Work items */}
          <Card id="work-items">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ListTodo className="h-4 w-4 text-primary" />
                Work Items
              </CardTitle>
              <CardDescription>
                Filter and inspect individual pipeline items. Click a row to see full stage history.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WorkItemList />
            </CardContent>
          </Card>

          {/* Operations utility section (preserved from Operations page) */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Utilities
            </h2>
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Curation */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Sparkles className="h-4 w-4 text-primary" />
                    Curation
                  </CardTitle>
                  <CardDescription>
                    Find and consolidate duplicate spores in the vault.
                    Preview shows which pairs would be merged; execute performs the consolidation.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CurationPanel />
                </CardContent>
              </Card>

              {/* Rebuild Index */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <RefreshCw className="h-4 w-4 text-primary" />
                    Rebuild Index
                  </CardTitle>
                  <CardDescription>
                    Reindex all vault notes for full-text search and vector embeddings.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <OperationButton
                      label="Rebuild"
                      endpoint="/rebuild"
                      icon={<RefreshCw className="h-4 w-4" />}
                      description="Rebuilds FTS5 and vector indexes from all vault notes."
                    />
                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">FTS entries:</span>
                        <Badge variant="secondary" className="font-mono text-xs">
                          {stats.index.fts_entries}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Vectors:</span>
                        <Badge variant="secondary" className="font-mono text-xs">
                          {stats.index.vector_count}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Reprocess */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Clock className="h-4 w-4 text-primary" />
                    Reprocess
                  </CardTitle>
                  <CardDescription>
                    Re-extract observations and regenerate summaries for past sessions.
                    Useful after LLM configuration changes or processing failures.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ReprocessPanel />
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      )}
    </PageLoading>
  );
}