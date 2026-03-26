import { Layers, Star } from 'lucide-react';
import { useAgentTasks, type TaskRow } from '../../hooks/use-agent';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { cn } from '../../lib/cn';
import { TASK_SOURCE_USER } from '../../lib/constants';

interface TaskListProps {
  onSelect: (taskId: string) => void;
}

/* ---------- Helpers ---------- */

/** Format phase count from the task's phases array. */
function formatPhaseCount(task: TaskRow): string {
  if (!task.phases || task.phases.length === 0) return 'Single query';
  return `${task.phases.length} phases`;
}

/** Map task source to Badge variant. */
function sourceBadgeVariant(source: string | undefined): 'warning' | 'secondary' {
  return source === TASK_SOURCE_USER ? 'warning' : 'secondary';
}

/** Map task source to label. */
function sourceLabel(source: string | undefined): string {
  return source === TASK_SOURCE_USER ? 'User' : 'Built-in';
}

/* ---------- Sub-components ---------- */

function TaskCard({ task, onClick }: { task: TaskRow; onClick: () => void }) {
  return (
    <Surface
      level="low"
      interactive
      className={cn(
        'p-4 space-y-2 transition-all',
        task.isDefault && 'ring-1 ring-primary/20 shadow-[inset_0_0_12px_rgba(171,207,184,0.08)]',
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-sans text-sm font-medium text-on-surface truncate">
              {task.displayName}
            </span>
            {task.isDefault && (
              <Star className="h-3.5 w-3.5 text-primary shrink-0 fill-primary/30" />
            )}
          </div>
          {task.description && (
            <p className="font-sans text-xs text-on-surface-variant mt-1 line-clamp-2">
              {task.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={sourceBadgeVariant(task.source)}>
            {sourceLabel(task.source)}
          </Badge>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <div className="flex items-center gap-1.5 text-on-surface-variant">
          <Layers className="h-3 w-3" />
          <span className="font-mono text-xs">{formatPhaseCount(task)}</span>
        </div>

        {task.model && (
          <span className="font-mono text-xs text-on-surface-variant/70 truncate max-w-[160px]">
            {task.model}
          </span>
        )}

        {task.maxTurns !== undefined && (
          <span className="font-mono text-xs text-on-surface-variant/70">
            max {task.maxTurns} turns
          </span>
        )}
      </div>
    </Surface>
  );
}

/* ---------- Component ---------- */

export function TaskList({ onSelect }: TaskListProps) {
  const { data, isLoading } = useAgentTasks();
  const tasks = data?.tasks ?? [];

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 rounded-md animate-pulse bg-surface-container-low" />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return <p className="font-sans text-sm text-on-surface-variant">No tasks found.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {tasks.map((task: TaskRow) => (
        <TaskCard key={task.name} task={task} onClick={() => onSelect(task.name)} />
      ))}
    </div>
  );
}
