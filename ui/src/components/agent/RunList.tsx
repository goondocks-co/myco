import { useMemo } from 'react';
import { Bot, AlertCircle, Play } from 'lucide-react';
import { Button } from '../ui/button';
import { useAgentRuns, useAgentTasks, type RunRow } from '../../hooks/use-agent';
import { cn } from '../../lib/cn';
import { formatEpochAgo, capitalize } from '../../lib/format';
import { statusBadgeVariant, formatCost, formatTokens, formatDuration, UNKNOWN_TASK_LABEL } from './helpers';

/* ---------- Constants ---------- */

/** Default limit for the run list. */
const DEFAULT_LIMIT = 50;

/* ---------- Helpers ---------- */

function formatEpochRelative(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return formatEpochAgo(epoch);
}

/* ---------- Sub-components ---------- */

function RunStatusBadge({ status }: { status: string }) {
  const variant = statusBadgeVariant(status);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold',
        variant === 'default' ? 'bg-primary-container/20 text-primary' :
        variant === 'destructive' ? 'bg-tertiary-container/20 text-tertiary' :
        variant === 'warning' ? 'bg-secondary-container/20 text-secondary' :
        'bg-surface-container-high text-on-surface-variant',
      )}
    >
      {capitalize(status)}
    </span>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-border">
      {[200, 80, 100, 80, 80].map((w, i) => (
        <td key={i} className="px-4 py-3">
          <div className={cn('h-4 animate-pulse rounded bg-muted')} style={{ width: w }} />
        </td>
      ))}
    </tr>
  );
}

function RunRowItem({
  run,
  onClick,
  taskNameMap,
}: {
  run: RunRow;
  onClick: () => void;
  taskNameMap: Map<string, string>;
}) {
  return (
    <tr
      className="border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground truncate max-w-xs">
            {run.task ? taskNameMap.get(run.task) ?? run.task : UNKNOWN_TASK_LABEL}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <RunStatusBadge status={run.status} />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
        {formatEpochRelative(run.started_at)}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
        {formatDuration(run.started_at, run.completed_at)}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
        {formatTokens(run.tokens_used)}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
        {formatCost(run.cost_usd)}
      </td>
    </tr>
  );
}

/* ---------- Component ---------- */

export interface RunListProps {
  onSelectRun: (id: string) => void;
  onTriggerRun: () => void;
}

export function RunList({ onSelectRun, onTriggerRun }: RunListProps) {
  const { data, isLoading, isError, error } = useAgentRuns({ limit: DEFAULT_LIMIT });
  const { data: tasksData } = useAgentTasks();
  const runs = data?.runs ?? [];
  const taskNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasksData?.tasks ?? []) {
      map.set(task.name, task.displayName);
    }
    return map;
  }, [tasksData]);

  const tableHeader = (
    <thead>
      <tr className="border-b border-border bg-muted/50">
        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Task</th>
        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Started</th>
        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Duration</th>
        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Tokens</th>
        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Cost</th>
      </tr>
    </thead>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full">
            {tableHeader}
            <tbody>
              {[1, 2, 3].map((i) => <SkeletonRow key={i} />)}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span className="text-sm">Failed to load runs</span>
        <span className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-lg border border-border text-muted-foreground">
          <Bot className="h-10 w-10 opacity-30" />
          <div className="text-center">
            <p className="text-sm">No agent runs yet</p>
            <p className="text-xs mt-1">Trigger the first run to see the agent at work</p>
          </div>
          <Button variant="outline" size="sm" className="gap-2 mt-2" onClick={onTriggerRun}>
            <Play className="h-3.5 w-3.5" />
            Run Now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full">
        {tableHeader}
        <tbody>
          {runs.map((run) => (
            <RunRowItem key={run.id} run={run} taskNameMap={taskNameMap} onClick={() => onSelectRun(run.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
