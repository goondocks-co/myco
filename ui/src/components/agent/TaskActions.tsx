import { useTriggerRun, useCopyTask, useDeleteTask, type TaskRow } from '../../hooks/use-agent';

/* ---------- Types ---------- */

interface TaskActionsProps {
  task: TaskRow;
  onRunTriggered?: () => void;
  onDeleted?: () => void;
}

/* ---------- Component ---------- */

export function TaskActions({ task, onRunTriggered, onDeleted }: TaskActionsProps) {
  const triggerRun = useTriggerRun();
  const copyTask = useCopyTask();
  const deleteTask = useDeleteTask();

  return (
    <div className="flex gap-2">
      <button
        onClick={() => {
          triggerRun.mutate({ task: task.id });
          onRunTriggered?.();
        }}
        className="px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
      >
        Run Now
      </button>

      {task.source === 'built-in' && (
        <button
          onClick={() => copyTask.mutate({ taskId: task.id })}
          className="px-3 py-1.5 text-sm font-medium rounded-md border hover:bg-accent"
        >
          Customize
        </button>
      )}

      {task.source === 'user' && (
        <button
          onClick={() => {
            deleteTask.mutate(task.id, { onSuccess: () => onDeleted?.() });
          }}
          className="px-3 py-1.5 text-sm font-medium rounded-md border border-destructive text-destructive hover:bg-destructive/10"
        >
          Delete
        </button>
      )}
    </div>
  );
}
