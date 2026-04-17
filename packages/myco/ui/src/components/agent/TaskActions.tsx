import { useState } from 'react';
import { useCopyTask, useDeleteTask, type TaskRow } from '../../hooks/use-agent';
import { TASK_SOURCE_BUILTIN, TASK_SOURCE_USER } from '../../lib/constants';
import { Button } from '../ui/button';
import { RunTaskDialog } from './RunTaskDialog';

/* ---------- Types ---------- */

interface TaskActionsProps {
  task: TaskRow;
  onRunTriggered?: (runId?: string) => void;
  onDeleted?: () => void;
  onCustomized?: (newTaskName: string) => void;
}

/* ---------- Component ---------- */

export function TaskActions({ task, onRunTriggered, onDeleted, onCustomized }: TaskActionsProps) {
  const copyTask = useCopyTask();
  const deleteTask = useDeleteTask();

  const [runDialogOpen, setRunDialogOpen] = useState(false);

  return (
    <div className="flex gap-2">
      <Button size="sm" onClick={() => setRunDialogOpen(true)}>
        Run Now
      </Button>

      {task.source === TASK_SOURCE_BUILTIN && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyTask.mutate({ taskId: task.name }, {
            onSuccess: (data) => {
              const newName = data?.task?.name;
              if (newName && onCustomized) onCustomized(newName);
            },
          })}
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

      <RunTaskDialog
        open={runDialogOpen}
        onOpenChange={setRunDialogOpen}
        preselectedTask={task}
        onTriggered={onRunTriggered}
      />
    </div>
  );
}
