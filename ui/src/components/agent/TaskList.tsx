import { useAgentTasks, type TaskRow } from '../../hooks/use-agent';
import { taskSourceClass, formatPhaseCount } from './helpers';

interface TaskListProps {
  onSelect: (taskId: string) => void;
}

export function TaskList({ onSelect }: TaskListProps) {
  const { data, isLoading } = useAgentTasks();
  const tasks = data?.tasks ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg border animate-pulse bg-muted" />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return <p className="text-muted-foreground text-sm">No tasks found.</p>;
  }

  return (
    <div className="space-y-2">
      {tasks.map((task: TaskRow) => (
        <button
          key={task.id}
          onClick={() => onSelect(task.id)}
          className="w-full text-left p-4 rounded-lg border hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{task.display_name ?? task.id}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${taskSourceClass(task.source)}`}>
                {task.source}
              </span>
              {task.is_default === 1 && (
                <span className="text-xs text-muted-foreground">(default)</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {formatPhaseCount(task.config)}
            </span>
          </div>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{task.description}</p>
          )}
        </button>
      ))}
    </div>
  );
}
