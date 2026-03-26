import { Bot, AlertCircle, Play } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useAgentRuns, type RunRow } from '../../hooks/use-agent';
import { formatEpochAgo, capitalize } from '../../lib/format';
import { formatCost, formatTokens, formatDuration } from './helpers';
import { cn } from '../../lib/cn';

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

/** Get the status dot color class. */
function statusDotColor(status: string): string {
  switch (status) {
    case 'completed': return 'bg-primary';
    case 'running':   return 'bg-secondary animate-pulse';
    case 'failed':    return 'bg-tertiary';
    default:          return 'bg-on-surface-variant';
  }
}

/** Get the row accent class for failed/completed runs. */
function rowAccentClass(status: string): string {
  switch (status) {
    case 'failed':    return 'border-l-2 border-l-tertiary/50';
    case 'completed': return 'border-l-2 border-l-primary/30';
    case 'running':   return 'border-l-2 border-l-secondary/40';
    default:          return 'border-l-2 border-l-transparent';
  }
}

/* ---------- Sub-components ---------- */

function SkeletonPod() {
  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-container-low px-4 py-3 animate-pulse">
      <div className="h-2.5 w-2.5 rounded-full bg-surface-container-high" />
      <div className="h-4 w-32 rounded bg-surface-container-high" />
      <div className="h-4 w-16 rounded bg-surface-container-high" />
      <div className="flex-1" />
      <div className="h-4 w-12 rounded bg-surface-container-high" />
      <div className="h-4 w-16 rounded bg-surface-container-high" />
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
    <div
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-md bg-surface-container-low px-4 py-3 transition-all cursor-pointer',
        'hover:brightness-110 dark:hover:brightness-[1.04]',
        rowAccentClass(run.status),
      )}
    >
      {/* Status dot */}
      <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', statusDotColor(run.status))} />

      {/* Task name */}
      <span className="font-sans text-sm text-on-surface font-medium min-w-0 truncate max-w-[200px]">
        {taskDisplayName(run)}
      </span>

      {/* Status badge */}
      <Badge variant={statusBadgeVariant(run.status)}>
        {capitalize(run.status)}
      </Badge>

      <div className="flex-1" />

      {/* Time ago */}
      <span className="font-mono text-xs text-on-surface-variant shrink-0">
        {formatEpochRelative(run.started_at)}
      </span>

      {/* Duration */}
      <span className="font-mono text-xs text-on-surface-variant/70 shrink-0 hidden sm:inline">
        {formatDuration(run.started_at, run.completed_at)}
      </span>

      {/* Tokens */}
      <span className="font-mono text-xs text-on-surface-variant/70 shrink-0 hidden md:inline">
        {formatTokens(run.tokens_used)}
      </span>

      {/* Cost */}
      <span className="font-mono text-xs text-on-surface-variant/70 shrink-0 hidden md:inline">
        {formatCost(run.cost_usd)}
      </span>
    </div>
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
      <div className="flex flex-col gap-1">
        {[1, 2, 3, 4].map((i) => <SkeletonPod key={i} />)}
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
    <div className="flex flex-col gap-1">
      {/* Column headers */}
      <div className="flex items-center gap-3 px-4 py-1.5 text-on-surface-variant">
        <span className="w-2.5" />
        <span className="font-sans text-xs uppercase tracking-wide font-medium min-w-0 max-w-[200px]">Task</span>
        <span className="font-sans text-xs uppercase tracking-wide font-medium w-20">Status</span>
        <div className="flex-1" />
        <span className="font-sans text-xs uppercase tracking-wide font-medium w-14 text-right">When</span>
        <span className="font-sans text-xs uppercase tracking-wide font-medium w-16 text-right hidden sm:inline">Duration</span>
        <span className="font-sans text-xs uppercase tracking-wide font-medium w-16 text-right hidden md:inline">Tokens</span>
        <span className="font-sans text-xs uppercase tracking-wide font-medium w-16 text-right hidden md:inline">Cost</span>
      </div>

      {runs.map((run) => (
        <RunPod key={run.id} run={run} onClick={() => onSelectRun(run.id)} />
      ))}
    </div>
  );
}
