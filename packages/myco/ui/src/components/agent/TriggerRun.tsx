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
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { inferRuntimeFromProviderType, resolveReasoningModel, useTaskConfig } from '../../hooks/use-providers';

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
  const { effective } = useScopedConfig();

  const { data: tasksData, isLoading: tasksLoading } = useAgentTasks();
  const { mutate: triggerRun, isPending, error } = useTriggerRun();

  // Pre-select the default task once tasks load
  const availableTasks: TaskRow[] = tasksData?.tasks ?? [];
  const defaultTask = availableTasks.find((t: TaskRow) => t.isDefault);
  const effectiveSelection = selectedTask ?? defaultTask?.name ?? availableTasks[0]?.name ?? '';
  const selectedTaskRow = availableTasks.find((task) => task.name === effectiveSelection);
  const { data: taskConfigData } = useTaskConfig(effectiveSelection || undefined);
  const taskConfig = taskConfigData?.config;
  const execution = selectedTaskRow?.execution;
  const globalProvider = effective?.agent?.provider;
  const effectiveRuntime = taskConfig?.runtime
    ?? taskConfig?.provider?.runtime
    ?? inferRuntimeFromProviderType(taskConfig?.provider?.type)
    ?? execution?.runtime
    ?? execution?.provider?.runtime
    ?? inferRuntimeFromProviderType(execution?.provider?.type)
    ?? globalProvider?.runtime
    ?? inferRuntimeFromProviderType(globalProvider?.type)
    ?? effective?.agent?.runtime
    ?? 'claude-sdk';
  const effectiveProvider = taskConfig?.provider?.type
    ?? execution?.provider?.type
    ?? globalProvider?.type
    ?? 'anthropic';
  const effectiveModel = resolveReasoningModel(
    execution?.reasoningLevel ?? selectedTaskRow?.reasoningLevel,
    taskConfig?.provider ?? execution?.provider ?? globalProvider,
    taskConfig?.provider?.model
      ?? taskConfig?.model
      ?? execution?.model
      ?? selectedTaskRow?.model
      ?? globalProvider?.model,
  );

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

          {selectedTaskRow && (
            <div className="rounded-md bg-surface-container-low p-3">
              <p className="font-sans text-xs text-on-surface-variant">Effective execution</p>
              <div className="mt-1 flex flex-wrap gap-4 font-mono text-xs text-on-surface">
                <span>runtime: {effectiveRuntime}</span>
                <span>provider: {effectiveProvider}</span>
                {effectiveModel && <span>model: {effectiveModel}</span>}
              </div>
            </div>
          )}

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
