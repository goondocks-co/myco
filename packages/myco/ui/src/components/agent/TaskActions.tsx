import { useState } from 'react';
import { useCopyTask, useDeleteTask, type TaskRow } from '../../hooks/use-agent';
import { TASK_SOURCE_BUILTIN, TASK_SOURCE_USER } from '../../lib/constants';
import { CAPABILITIES, capabilityEnabled } from '@myco/config/capabilities';
import type { MycoConfig } from '@myco/config/schema';
import { useScopedConfig } from '../../hooks/use-scoped-config';
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
  const { effective } = useScopedConfig();

  const [runDialogOpen, setRunDialogOpen] = useState(false);

  // Disables the Run Now action with a reason when the task's governing
  // capability is off. `governingCapability` comes from the tasks-listing API.
  const capId = task.governingCapability;
  const capabilityOff = capId != null && !capabilityEnabled(effective as MycoConfig | undefined, capId);
  const disabledReason = capabilityOff
    ? `Enable ${CAPABILITIES[capId].label} for this project to run ${task.name}`
    : undefined;

  return (
    <div className="flex gap-2">
      <span title={disabledReason}>
        <Button size="sm" onClick={() => setRunDialogOpen(true)} disabled={capabilityOff}>
          Run Now
        </Button>
      </span>

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
