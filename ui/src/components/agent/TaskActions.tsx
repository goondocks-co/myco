import { useTriggerRun, useCopyTask, useDeleteTask, type TaskRow } from '../../hooks/use-agent';
import { TASK_SOURCE_BUILTIN, TASK_SOURCE_USER } from '../../lib/constants';
import { Button } from '../ui/button';

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
      <Button
        size="sm"
        onClick={() => {
          triggerRun.mutate({ task: task.name });
          onRunTriggered?.();
        }}
      >
        Run Now
      </Button>

      {task.source === TASK_SOURCE_BUILTIN && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyTask.mutate({ taskId: task.name })}
        >
          Customize
        </Button>
      )}

      {task.source === TASK_SOURCE_USER && (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            deleteTask.mutate(task.name, { onSuccess: () => onDeleted?.() });
          }}
        >
          Delete
        </Button>
      )}
    </div>
  );
}
