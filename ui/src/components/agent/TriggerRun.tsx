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

/* ---------- Constants ---------- */

/** Placeholder value for "no task selected" in the Select component. */
const NO_TASK_VALUE = '__default__';

/* ---------- Helpers ---------- */

function taskLabel(task: TaskRow): string {
  return task.display_name ?? task.id;
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

  const { data: tasks, isLoading: tasksLoading } = useAgentTasks();
  const { mutate: triggerRun, isPending, error } = useTriggerRun();

  // Pre-select the default task once tasks load
  const availableTasks = tasks ?? [];
  const defaultTask = availableTasks.find(t => t.is_default === 1);
  const effectiveSelection = selectedTask ?? defaultTask?.id ?? availableTasks[0]?.id ?? '';

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
            <label className="text-sm font-medium text-foreground">Task</label>
            {tasksLoading ? (
              <div className="flex h-9 items-center gap-2 text-muted-foreground text-sm">
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
                    <SelectItem key={task.id} value={task.id}>
                      {taskLabel(task)}
                      {task.is_default === 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">(default)</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Instruction field */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Instruction
              <span className="ml-1 text-xs text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              rows={3}
              placeholder="E.g. Focus on gotchas from yesterday's sessions…"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={isPending}
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-destructive">
              {error instanceof Error ? error.message : 'Failed to trigger run'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
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
