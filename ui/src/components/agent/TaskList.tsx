import { useAgentTasks, type TaskRow } from '../../hooks/use-agent';
import { Badge } from '../ui/badge';
import { SessionPod, PodTitle, PodMeta } from '../ui/session-pod';
import { TASK_SOURCE_USER } from '../../lib/constants';

interface TaskListProps {
  onSelect: (taskId: string) => void;
}

/** Format phase count from the task's phases array. */
function formatPhaseCount(task: TaskRow): string {
  if (!task.phases || task.phases.length === 0) return 'Single query';
  return `${task.phases.length} phases`;
}

/** Map task source to Badge variant. */
function sourceBadgeVariant(source: string | undefined): 'warning' | 'secondary' {
  return source === TASK_SOURCE_USER ? 'warning' : 'secondary';
}

export function TaskList({ onSelect }: TaskListProps) {
  const { data, isLoading } = useAgentTasks();
  const tasks = data?.tasks ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-0.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 rounded-md animate-pulse bg-surface-container-low" />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return <p className="font-sans text-sm text-on-surface-variant">No tasks found.</p>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tasks.map((task: TaskRow) => (
        <SessionPod key={task.name} onClick={() => onSelect(task.name)}>
          <PodTitle className="font-sans min-w-0 flex-1">
            {task.displayName}
          </PodTitle>
          <Badge variant={sourceBadgeVariant(task.source)}>
            {task.source ?? 'built-in'}
          </Badge>
          {task.isDefault && (
            <PodMeta>(default)</PodMeta>
          )}
          {task.description && (
            <PodMeta className="hidden sm:inline max-w-[200px] truncate">
              {task.description}
            </PodMeta>
          )}
          <PodMeta>{formatPhaseCount(task)}</PodMeta>
        </SessionPod>
      ))}
    </div>
  );
}
