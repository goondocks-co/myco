import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import { usePipeline, type PipelineHealth } from '../../hooks/use-pipeline';
import { postJson } from '../../lib/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const PIPELINE_STAGES = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;

const STAGE_LABELS: Record<string, string> = {
  capture: 'Capture',
  extraction: 'Extraction',
  embedding: 'Embedding',
  consolidation: 'Consolidation',
  digest: 'Digest',
};

/**
 * Maps each pipeline stage to the provider role whose circuit breaker
 * affects that stage. Used to show circuit warnings on stage boxes.
 */
const STAGE_PROVIDER_MAP: Record<string, string> = {
  extraction: 'extraction',
  embedding: 'embedding',
  consolidation: 'consolidation',
  digest: 'digest',
};

type StageHealth = 'healthy' | 'active' | 'degraded' | 'empty';

const STAGE_BORDER_CLASSES: Record<StageHealth, string> = {
  healthy: 'border-emerald-500/50',
  active: 'border-amber-400/50',
  degraded: 'border-red-500/50',
  empty: 'border-border',
};

const STAGE_BG_CLASSES: Record<StageHealth, string> = {
  healthy: 'bg-emerald-500/5',
  active: 'bg-amber-400/5',
  degraded: 'bg-red-500/5',
  empty: 'bg-card',
};

/* ---------- Helpers ---------- */

function classifyStageHealth(counts: Record<string, number> | undefined): StageHealth {
  if (!counts) return 'empty';

  const failed = (counts.failed ?? 0) + (counts.blocked ?? 0) + (counts.poisoned ?? 0);
  const active = (counts.pending ?? 0) + (counts.processing ?? 0);

  if (failed > 0) return 'degraded';
  if (active > 0) return 'active';
  if (counts.succeeded && counts.succeeded > 0) return 'healthy';
  return 'empty';
}

function isCircuitOpen(
  circuits: PipelineHealth['circuits'],
  providerRole: string | undefined,
): boolean {
  if (!providerRole) return false;
  return circuits.some((c) => c.provider_role === providerRole && c.state === 'open');
}

/* ---------- Stage Box ---------- */

function StageBox({
  stage,
  counts,
  circuitOpen,
  onClick,
}: {
  stage: string;
  counts: Record<string, number> | undefined;
  circuitOpen: boolean;
  onClick?: (stage: string) => void;
}) {
  const health = classifyStageHealth(counts);
  const succeeded = counts?.succeeded ?? 0;
  const pending = (counts?.pending ?? 0) + (counts?.processing ?? 0);
  const failed = (counts?.failed ?? 0) + (counts?.blocked ?? 0) + (counts?.poisoned ?? 0);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(stage)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(stage); }}
      className={cn(
        'relative flex flex-col items-center gap-1 rounded-lg border-2 px-4 py-3 transition-colors min-w-[120px] cursor-pointer hover:opacity-80',
        STAGE_BORDER_CLASSES[health],
        STAGE_BG_CLASSES[health],
      )}
    >
      {/* Circuit breaker warning */}
      {circuitOpen && (
        <div className="absolute -top-2 -right-2" title="Circuit breaker open">
          <ShieldAlert className="h-4 w-4 text-red-500" />
        </div>
      )}

      <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
        {STAGE_LABELS[stage] ?? stage}
      </span>

      <div className="flex items-center gap-2 text-xs">
        {succeeded > 0 && (
          <span className="font-mono text-emerald-600 dark:text-emerald-400">
            {succeeded} done
          </span>
        )}
        {pending > 0 && (
          <span className="font-mono text-amber-600 dark:text-amber-400">
            {pending} pending
          </span>
        )}
        {failed > 0 && (
          <span className="font-mono text-red-600 dark:text-red-400">
            {failed} err
          </span>
        )}
        {succeeded === 0 && pending === 0 && failed === 0 && (
          <span className="font-mono text-muted-foreground">--</span>
        )}
      </div>
    </div>
  );
}

/* ---------- Arrow connector ---------- */

function StageArrow() {
  return (
    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
  );
}

/* ---------- Circuit Breaker Alert Banner ---------- */

function CircuitBreakerBanner({ circuits }: { circuits: PipelineHealth['circuits'] }) {
  const [resettingProvider, setResettingProvider] = useState<string | null>(null);
  const openCircuits = circuits.filter((c) => c.state === 'open');

  if (openCircuits.length === 0) return null;

  const handleReset = async (providerRole: string) => {
    setResettingProvider(providerRole);
    try {
      await postJson(`/pipeline/circuit/${encodeURIComponent(providerRole)}/reset`, {});
    } finally {
      setResettingProvider(null);
    }
  };

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium text-destructive">Circuit Breakers Open</p>
          {openCircuits.map((c) => (
            <div
              key={c.provider_role}
              className="flex items-center justify-between gap-4 rounded-md bg-destructive/5 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground">
                  {c.provider_role}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {c.failure_count} failures
                </span>
                {c.last_error && (
                  <p className="mt-0.5 truncate text-xs text-destructive/70">
                    {c.last_error}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={resettingProvider === c.provider_role}
                onClick={() => handleReset(c.provider_role)}
              >
                {resettingProvider === c.provider_role ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Reset
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Backlog Indicator ---------- */

function BacklogIndicator({ totals }: { totals: PipelineHealth['totals'] }) {
  const pending = totals.pending + totals.processing;
  const total = Object.values(totals).reduce((s, n) => s + n, 0);
  const MAX_BACKLOG_BAR_WIDTH = 100;

  if (total === 0) return null;

  const backlogPercent = total > 0 ? Math.min((pending / total) * MAX_BACKLOG_BAR_WIDTH, MAX_BACKLOG_BAR_WIDTH) : 0;

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground">Backlog</span>
      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            pending > 0 ? 'bg-amber-400' : 'bg-emerald-500',
          )}
          style={{ width: `${MAX_BACKLOG_BAR_WIDTH - backlogPercent}%` }}
        />
      </div>
      <div className="flex items-center gap-2">
        {pending > 0 && (
          <Badge variant="secondary" className="font-mono text-xs">
            {pending} pending
          </Badge>
        )}
        <Badge variant="secondary" className="font-mono text-xs">
          {total} total
        </Badge>
      </div>
    </div>
  );
}

/* ---------- Main Component ---------- */

export function PipelineVisualization() {
  const { data: health, isLoading, isError } = usePipeline();
  const [, setSearchParams] = useSearchParams();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading pipeline health...
      </div>
    );
  }

  if (isError || !health) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Pipeline health unavailable
      </div>
    );
  }

  const handleStageClick = (stage: string) => {
    setSearchParams({ stage });
    // Scroll to work items section
    document.getElementById('work-items')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="space-y-4">
      {/* Circuit breaker alert banner */}
      <CircuitBreakerBanner circuits={health.circuits} />

      {/* Horizontal pipeline flow */}
      <div className="flex items-center justify-center gap-2 overflow-x-auto py-2">
        {PIPELINE_STAGES.map((stage, idx) => (
          <div key={stage} className="flex items-center gap-2">
            {idx > 0 && <StageArrow />}
            <StageBox
              stage={stage}
              counts={health.stages[stage]}
              circuitOpen={isCircuitOpen(health.circuits, STAGE_PROVIDER_MAP[stage])}
              onClick={handleStageClick}
            />
          </div>
        ))}
      </div>

      {/* Backlog indicator */}
      <BacklogIndicator totals={health.totals} />
    </div>
  );
}
