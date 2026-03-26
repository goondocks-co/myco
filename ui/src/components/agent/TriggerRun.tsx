import { useState } from 'react';
import { Play, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { useAgentTasks, useTriggerRun, type TaskRow } from '../../hooks/use-agent';

/* ---------- Helpers ---------- */

function taskLabel(task: TaskRow): string {
  return task.displayName ?? task.name;
}

/* ---------- Component ---------- */

export interface TriggerRunProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTriggered?: () => void;
}

export function TriggerRun({ open, onOpenChange, onTriggered }: TriggerRunProps) {
  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [instruction, setInstruction] = useState('');

  const { data: tasksData, isLoading: tasksLoading } = useAgentTasks();
  const { mutate: triggerRun, isPending, error } = useTriggerRun();

  // Pre-select the default task once tasks load
  const availableTasks: TaskRow[] = tasksData?.tasks ?? [];
  const defaultTask = availableTasks.find((t: TaskRow) => t.isDefault);
  const effectiveSelection = selectedTask ?? defaultTask?.name ?? availableTasks[0]?.name ?? '';

  function handleRun() {
    const payload = {
      task: effectiveSelection || undefined,
      instruction: instruction.trim() || undefined,
    };

    triggerRun(payload, {
      onSuccess: () => {
        onOpenChange(false);
        setSelectedTask(undefined);
        setInstruction('');
        onTriggered?.();
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Trigger Agent Run</DialogTitle>
          <DialogDescription>
            Run the Myco agent now. It will process unprocessed sessions and update the vault.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Task picker */}
          <div className="space-y-1.5">
            <label className="font-sans text-sm font-medium text-on-surface">Task</label>
            {tasksLoading ? (
              <div className="flex h-9 items-center gap-2 text-on-surface-variant font-sans text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading tasks...
              </div>
            ) : (
              <Select value={effectiveSelection} onValueChange={setSelectedTask}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableTasks.map((task) => (
                    <SelectItem key={task.name} value={task.name}>
                      {taskLabel(task)}
                      {task.isDefault && (
                        <span className="ml-1 font-sans text-xs text-on-surface-variant">(default)</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Instruction field */}
          <div className="space-y-1.5">
            <label className="font-sans text-sm font-medium text-on-surface">
              Instruction
              <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">(optional)</span>
            </label>
            <textarea
              className="w-full rounded-md bg-surface-container-lowest px-3 py-2 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              rows={3}
              placeholder="E.g. Focus on gotchas from yesterday's sessions..."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={isPending}
            />
          </div>

          {/* Error */}
          {error && (
            <p className="font-sans text-xs text-tertiary">
              {error instanceof Error ? error.message : 'Failed to trigger run'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-2"
            onClick={handleRun}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                Run Now
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
