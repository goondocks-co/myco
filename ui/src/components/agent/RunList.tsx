import { Bot, AlertCircle, Play } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { SessionPod, PodTitle, PodTimestamp, PodMeta } from '../ui/session-pod';
import { useAgentRuns, type RunRow } from '../../hooks/use-agent';
import { formatEpochAgo, capitalize } from '../../lib/format';
import { formatCost, formatTokens, formatDuration } from './helpers';

/* ---------- Constants ---------- */

/** Default limit for the run list. */
const DEFAULT_LIMIT = 50;

/* ---------- Helpers ---------- */

function formatEpochRelative(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return formatEpochAgo(epoch);
}

function taskDisplayName(run: RunRow): string {
  return run.task ?? 'Default task';
}

/** Map run status to Badge variant. */
function statusBadgeVariant(status: string): 'default' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed': return 'default';
    case 'running':   return 'warning';
    case 'failed':    return 'destructive';
    default:          return 'secondary';
  }
}

/* ---------- Sub-components ---------- */

function SkeletonPod() {
  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-container-low px-4 py-2.5 animate-pulse">
      <div className="h-4 w-24 rounded bg-surface-container-high" />
      <div className="h-4 w-16 rounded bg-surface-container-high" />
      <div className="flex-1" />
      <div className="h-4 w-12 rounded bg-surface-container-high" />
    </div>
  );
}

function RunPod({
  run,
  onClick,
}: {
  run: RunRow;
  onClick: () => void;
}) {
  return (
    <SessionPod onClick={onClick}>
      <PodTitle className="min-w-0 flex-1 font-sans">
        {taskDisplayName(run)}
      </PodTitle>
      <Badge variant={statusBadgeVariant(run.status)}>
        {capitalize(run.status)}
      </Badge>
      <PodTimestamp>{formatEpochRelative(run.started_at)}</PodTimestamp>
      <PodMeta>{formatDuration(run.started_at, run.completed_at)}</PodMeta>
      <PodMeta>{formatTokens(run.tokens_used)}</PodMeta>
      <PodMeta>{formatCost(run.cost_usd)}</PodMeta>
    </SessionPod>
  );
}

/* ---------- Component ---------- */

export interface RunListProps {
  onSelectRun: (id: string) => void;
  onTriggerRun: () => void;
}

export function RunList({ onSelectRun, onTriggerRun }: RunListProps) {
  const { data, isLoading, isError, error } = useAgentRuns({ limit: DEFAULT_LIMIT });
  const runs = data?.runs ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-0.5">
        {[1, 2, 3].map((i) => <SkeletonPod key={i} />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Failed to load runs</span>
        <span className="font-sans text-xs text-on-surface-variant">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-md bg-surface-container-low text-on-surface-variant">
        <Bot className="h-10 w-10 opacity-30" />
        <div className="text-center">
          <p className="font-sans text-sm">No agent runs yet</p>
          <p className="font-sans text-xs mt-1">Trigger the first run to see the agent at work</p>
        </div>
        <Button variant="ghost" size="sm" className="gap-2 mt-2" onClick={onTriggerRun}>
          <Play className="h-3.5 w-3.5" />
          Run Now
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {runs.map((run) => (
        <RunPod key={run.id} run={run} onClick={() => onSelectRun(run.id)} />
      ))}
    </div>
  );
}
