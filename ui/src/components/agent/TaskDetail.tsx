import { ArrowLeft, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { useTask, type PhaseDefinition } from '../../hooks/use-agent';
import { cn } from '../../lib/cn';
import { capitalize } from '../../lib/format';
import { taskSourceClass } from './helpers';
import { TaskActions } from './TaskActions';
import { TaskEditor } from './TaskEditor';

/* ---------- Constants ---------- */

/** Columns in the execution config grid. */
const CONFIG_GRID_COLS = 3;

/* ---------- Types ---------- */

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  onNavigate?: (taskId: string) => void;
}

/* ---------- Helpers ---------- */

/** Resolve effective execution config from task fields. */
function getExecution(task: { execution?: { model?: string; maxTurns?: number; timeoutSeconds?: number }; model?: string; maxTurns?: number; timeoutSeconds?: number }) {
  return {
    model: task.execution?.model ?? task.model,
    maxTurns: task.execution?.maxTurns ?? task.maxTurns,
    timeoutSeconds: task.execution?.timeoutSeconds ?? task.timeoutSeconds,
  };
}

/* ---------- Sub-components ---------- */

function SkeletonDetail() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-24 animate-pulse rounded bg-muted" />
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-64 animate-pulse rounded bg-muted" />
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        {Array.from({ length: CONFIG_GRID_COLS }).map((_, i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </div>
  );
}

function PhaseCard({ phase, index }: { phase: PhaseDefinition; index: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground shrink-0">
            {index + 1}
          </span>
          <span className="font-medium text-sm">{phase.name}</span>
          {!phase.required && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">optional</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground font-mono shrink-0">
          max {phase.maxTurns} turns
        </span>
      </div>

      {phase.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {phase.tools.map((tool) => (
            <span
              key={tool}
              className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono"
            >
              {tool}
            </span>
          ))}
        </div>
      )}

      <pre className="rounded bg-muted p-3 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words overflow-auto max-h-40">
        {phase.prompt}
      </pre>
    </div>
  );
}

/* ---------- Component ---------- */

export function TaskDetail({ taskId, onBack, onNavigate }: TaskDetailProps) {
  const { data, isPending, isError } = useTask(taskId);

  if (isPending) {
    return <SkeletonDetail />;
  }

  if (isError || !data?.task) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          Tasks
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm">Task not found</span>
        </div>
      </div>
    );
  }

  const task = data.task;
  const phases: PhaseDefinition[] = task.phases ?? [];
  const execution = getExecution(task);

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-muted-foreground">
        <ArrowLeft className="h-4 w-4" />
        Tasks
      </Button>

      {/* Header card */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 space-y-1 min-w-0">
            <h1 className="text-lg font-semibold text-foreground">
              {task.displayName}
            </h1>
            {task.description && (
              <p className="text-sm text-muted-foreground">{task.description}</p>
            )}
          </div>

          <span
            className={cn(
              'text-xs px-2 py-0.5 rounded-full shrink-0',
              taskSourceClass(task.source ?? ''),
            )}
          >
            {capitalize(task.source ?? 'built-in')}
          </span>
        </div>

        <TaskActions
          task={task}
          onDeleted={onBack}
          onCustomized={(newName) => onNavigate?.(newName)}
        />
      </div>

      {/* Execution config */}
      {(execution.model !== undefined || execution.maxTurns !== undefined || execution.timeoutSeconds !== undefined) && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Execution Config
          </h2>
          <div className="grid grid-cols-3 gap-4">
            {execution.model !== undefined && (
              <div>
                <p className="text-xs text-muted-foreground">Model</p>
                <p className="text-sm font-mono text-foreground mt-0.5">{execution.model}</p>
              </div>
            )}
            {execution.maxTurns !== undefined && (
              <div>
                <p className="text-xs text-muted-foreground">Max Turns</p>
                <p className="text-sm font-mono text-foreground mt-0.5">{execution.maxTurns}</p>
              </div>
            )}
            {execution.timeoutSeconds !== undefined && (
              <div>
                <p className="text-xs text-muted-foreground">Timeout</p>
                <p className="text-sm font-mono text-foreground mt-0.5">{execution.timeoutSeconds}s</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Phases */}
      {phases.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Phases
            <span className="ml-2 text-foreground normal-case font-normal">
              {phases.length} {phases.length === 1 ? 'phase' : 'phases'}
            </span>
          </h2>
          {phases.map((phase, i) => (
            <PhaseCard key={phase.name} phase={phase} index={i} />
          ))}
        </div>
      ) : (
        /* Single-phase prompt */
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Prompt
          </h2>
          <pre className="rounded-lg border border-border bg-muted p-4 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words overflow-auto max-h-96">
            {task.prompt}
          </pre>
        </div>
      )}

      {/* YAML Editor */}
      <TaskEditor taskId={taskId} />
    </div>
  );
}
