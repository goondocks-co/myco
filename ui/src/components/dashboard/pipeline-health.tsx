import { Link } from 'react-router-dom';
import { AlertTriangle, Workflow } from 'lucide-react';
import { usePipeline, type PipelineHealth } from '../../hooks/use-pipeline';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const PIPELINE_STAGE_ORDER = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;

const STAGE_LABELS: Record<string, string> = {
  capture: 'Capture',
  extraction: 'Extraction',
  embedding: 'Embedding',
  consolidation: 'Consolidation',
  digest: 'Digest',
};

/* ---------- Helpers ---------- */

type StageHealthStatus = 'healthy' | 'active' | 'degraded' | 'empty';

function classifyStage(counts: Record<string, number> | undefined): StageHealthStatus {
  if (!counts) return 'empty';

  const failed = (counts.failed ?? 0) + (counts.blocked ?? 0) + (counts.poisoned ?? 0);
  const active = (counts.pending ?? 0) + (counts.processing ?? 0);

  if (failed > 0) return 'degraded';
  if (active > 0) return 'active';
  if (counts.succeeded && counts.succeeded > 0) return 'healthy';
  return 'empty';
}

const STATUS_DOT_CLASSES: Record<StageHealthStatus, string> = {
  healthy: 'bg-emerald-500',
  active: 'bg-amber-400',
  degraded: 'bg-red-500',
  empty: 'bg-muted-foreground/30',
};

function stageItemTotal(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/* ---------- Sub-components ---------- */

function StageRow({ stage, counts }: { stage: string; counts: Record<string, number> | undefined }) {
  const status = classifyStage(counts);
  const total = stageItemTotal(counts);
  const failed = counts ? (counts.failed ?? 0) + (counts.blocked ?? 0) + (counts.poisoned ?? 0) : 0;

  return (
    <Link
      to={`/mycelium?stage=${stage}`}
      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', STATUS_DOT_CLASSES[status])} />
        <span className="text-foreground">{STAGE_LABELS[stage] ?? stage}</span>
      </div>
      <div className="flex items-center gap-2">
        {failed > 0 && (
          <Badge variant="destructive" className="text-xs font-mono px-1.5 py-0">
            {failed}
          </Badge>
        )}
        <span className="font-mono text-xs text-muted-foreground">{total}</span>
      </div>
    </Link>
  );
}

function CircuitAlert({ circuits }: { circuits: PipelineHealth['circuits'] }) {
  const openCircuits = circuits.filter((c) => c.state === 'open');
  if (openCircuits.length === 0) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="space-y-0.5">
        {openCircuits.map((c) => (
          <div key={c.provider_role} className="text-destructive">
            <span className="font-medium">{c.provider_role}</span>
            <span className="text-destructive/70">
              {' '}&mdash; circuit open ({c.failure_count} failures)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Main component ---------- */

export function PipelineHealthCard() {
  const { data: health, isLoading, isError } = usePipeline();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Workflow className="h-4 w-4 text-primary" />
          Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {isError && (
          <p className="text-sm text-muted-foreground">Pipeline unavailable</p>
        )}
        {health && (
          <>
            {/* Circuit breaker alerts */}
            <CircuitAlert circuits={health.circuits} />

            {/* Stage rows */}
            <div className="-mx-2 space-y-0.5">
              {PIPELINE_STAGE_ORDER.map((stage) => (
                <StageRow key={stage} stage={stage} counts={health.stages[stage]} />
              ))}
            </div>

            {/* Summary line */}
            <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
              <span>Total items</span>
              <span className="font-mono">
                {Object.values(health.totals).reduce((s, n) => s + n, 0)}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
