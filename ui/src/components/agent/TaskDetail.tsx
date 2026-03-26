import { ArrowLeft, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { MarkdownContent } from '../ui/markdown-content';
import { useTask, type PhaseDefinition } from '../../hooks/use-agent';
import { capitalize } from '../../lib/format';
import { sourceBadgeVariant } from './helpers';
import { TaskActions } from './TaskActions';
import { TaskEditor } from './TaskEditor';
import { TaskProviderConfig } from './TaskProviderConfig';

/* ---------- Constants ---------- */

/** Columns in the execution config grid. */
const CONFIG_GRID_COLS = 3;

/* ---------- Types ---------- */

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  onNavigate?: (taskId: string) => void;
  onRunTriggered?: (runId?: string) => void;
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
      <div className="h-8 w-24 animate-pulse rounded bg-surface-container-high" />
      <div className="rounded-md bg-surface-container-low p-4 space-y-3">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-container-high" />
        <div className="h-4 w-64 animate-pulse rounded bg-surface-container-high" />
        <div className="h-8 w-32 animate-pulse rounded bg-surface-container-high" />
      </div>
      <div className="rounded-md bg-surface-container-low p-4 space-y-2">
        {Array.from({ length: CONFIG_GRID_COLS }).map((_, i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-surface-container-high" />
        ))}
      </div>
    </div>
  );
}

function PhaseCard({ phase, index }: { phase: PhaseDefinition; index: number }) {
  return (
    <Surface level="low" className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-container-high font-mono text-xs font-semibold text-on-surface-variant shrink-0">
            {index + 1}
          </span>
          <span className="font-sans text-sm font-medium text-on-surface">{phase.name}</span>
          {!phase.required && (
            <Badge variant="secondary">optional</Badge>
          )}
        </div>
        <span className="font-mono text-xs text-on-surface-variant shrink-0">
          max {phase.maxTurns} turns
        </span>
      </div>

      {phase.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {phase.tools.map((tool) => (
            <span
              key={tool}
              className="font-mono text-xs px-1.5 py-0.5 rounded-sm bg-surface-container-high text-on-surface-variant"
            >
              {tool}
            </span>
          ))}
        </div>
      )}

      <Surface level="lowest" className="p-3 overflow-auto max-h-40">
        <MarkdownContent content={phase.prompt} />
      </Surface>
    </Surface>
  );
}

/* ---------- Component ---------- */

export function TaskDetail({ taskId, onBack, onNavigate, onRunTriggered }: TaskDetailProps) {
  const { data, isPending, isError } = useTask(taskId);

  if (isPending) {
    return <SkeletonDetail />;
  }

  if (isError || !data?.task) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          Tasks
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Task not found</span>
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
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
        <ArrowLeft className="h-4 w-4" />
        Tasks
      </Button>

      {/* Header card */}
      <Surface level="low" className="p-4 space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 space-y-1 min-w-0">
            <h1 className="font-serif text-lg text-on-surface">
              {task.displayName}
            </h1>
            {task.description && (
              <p className="font-sans text-sm text-on-surface-variant">{task.description}</p>
            )}
          </div>

          <Badge variant={sourceBadgeVariant(task.source)} className="shrink-0">
            {capitalize(task.source ?? 'built-in')}
          </Badge>
        </div>

        <TaskActions
          task={task}
          onDeleted={onBack}
          onCustomized={(newName) => onNavigate?.(newName)}
          onRunTriggered={onRunTriggered}
        />
      </Surface>

      {/* Provider config */}
      <TaskProviderConfig
        taskId={taskId}
        phases={phases}
        defaults={{ model: execution.model, maxTurns: execution.maxTurns, timeoutSeconds: execution.timeoutSeconds }}
      />

      {/* Execution config */}
      {(execution.model !== undefined || execution.maxTurns !== undefined || execution.timeoutSeconds !== undefined) && (
        <Surface level="low" className="p-4 space-y-3">
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Execution Config
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {execution.model !== undefined && (
              <div>
                <p className="font-sans text-xs text-on-surface-variant">Model</p>
                <p className="font-mono text-sm text-on-surface mt-0.5">{execution.model}</p>
              </div>
            )}
            {execution.maxTurns !== undefined && (
              <div>
                <p className="font-sans text-xs text-on-surface-variant">Max Turns</p>
                <p className="font-mono text-sm text-on-surface mt-0.5">{execution.maxTurns}</p>
              </div>
            )}
            {execution.timeoutSeconds !== undefined && (
              <div>
                <p className="font-sans text-xs text-on-surface-variant">Timeout</p>
                <p className="font-mono text-sm text-on-surface mt-0.5">{execution.timeoutSeconds}s</p>
              </div>
            )}
          </div>
        </Surface>
      )}

      {/* Phases */}
      {phases.length > 0 ? (
        <div className="space-y-3">
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Phases
            <span className="ml-2 text-on-surface normal-case font-normal">
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
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Prompt
          </h2>
          <Surface level="lowest" className="p-4 overflow-auto max-h-96">
            <MarkdownContent content={task.prompt ?? ''} />
          </Surface>
        </div>
      )}

      {/* YAML Editor */}
      <TaskEditor taskId={taskId} />
    </div>
  );
}
