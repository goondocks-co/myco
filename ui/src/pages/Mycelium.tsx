import { useState, useMemo } from 'react';
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
import { OperationButton } from '../components/operations/OperationButton';
import { CurationPanel } from '../components/operations/CurationPanel';
import { ReprocessPanel } from '../components/operations/ReprocessPanel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Button } from '../components/ui/button';
import { PageLoading } from '../components/ui/page-loading';

/* ---------- Constants ---------- */

const DIGEST_TIERS = [1500, 3000, 5000, 7500, 10000] as const;
const DEFAULT_DIGEST_TIER = '3000';

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

          {/* Circuit breakers */}
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

              {/* Manual Digest */}
              <DigestSection
                digestEnabled={!!stats.digest}
                metabolismState={stats.digest?.metabolism_state ?? null}
                substrateQueue={stats.digest?.substrate_queue ?? 0}
              />

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

/* ---------- Digest Section ---------- */

function DigestSection({
  digestEnabled,
  metabolismState,
  substrateQueue,
}: {
  digestEnabled: boolean;
  metabolismState: string | null;
  substrateQueue: number;
}) {
  const [selectedTier, setSelectedTier] = useState(DEFAULT_DIGEST_TIER);
  const [mode, setMode] = useState<'tier' | 'full'>('tier');

  const digestBody = useMemo(
    () => (mode === 'full' ? { full: true } : { tier: Number(selectedTier) }),
    [mode, selectedTier],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="h-4 w-4 text-primary" />
          Manual Digest
        </CardTitle>
        <CardDescription>
          Trigger a digest cycle to synthesize vault knowledge into context extracts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-2">
            <Button
              variant={mode === 'tier' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('tier')}
            >
              Single Tier
            </Button>
            <Button
              variant={mode === 'full' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('full')}
            >
              Full Digest
            </Button>
          </div>

          {/* Tier selector (only when in tier mode) */}
          {mode === 'tier' && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Tier:</span>
              <Select value={selectedTier} onValueChange={setSelectedTier}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIGEST_TIERS.map((tier) => (
                    <SelectItem key={tier} value={String(tier)}>
                      T{tier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <OperationButton
            label={mode === 'full' ? 'Run Full Digest' : `Run T${selectedTier} Digest`}
            endpoint="/digest"
            body={digestBody}
            icon={<Brain className="h-4 w-4" />}
          />

          {/* Digest status */}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Status:</span>
              <Badge
                variant={digestEnabled ? 'default' : 'secondary'}
                className="text-xs"
              >
                {digestEnabled
                  ? (metabolismState ?? 'dormant')
                  : 'disabled'}
              </Badge>
            </div>
            {digestEnabled && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Queue:</span>
                <Badge variant="secondary" className="font-mono text-xs">
                  {substrateQueue}
                </Badge>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
