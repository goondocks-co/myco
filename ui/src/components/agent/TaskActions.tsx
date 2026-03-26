import { useState, useMemo } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useTriggerRun, useCopyTask, useDeleteTask, type TaskRow } from '../../hooks/use-agent';
import { TASK_SOURCE_BUILTIN, TASK_SOURCE_USER } from '../../lib/constants';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';

/* ---------- Constants ---------- */

/** Variables that are always auto-resolved (never shown as inputs). */
const AUTO_RESOLVED_VARS = new Set(['instruction']);

/** Human-readable labels for known template variables. */
const VAR_LABELS: Record<string, string> = {
  session_id: 'Session ID',
};

/** Placeholder text for known template variables. */
const VAR_PLACEHOLDERS: Record<string, string> = {
  session_id: 'e.g. 36858a44-4ef7-4448-96e8-382e992e8ba4',
};

/* ---------- Helpers ---------- */

/** Extract {{variable}} template variables from a task prompt. */
function extractTemplateVars(prompt: string): string[] {
  const matches = prompt.matchAll(/\{\{(\w+)\}\}/g);
  const vars = new Set<string>();
  for (const m of matches) {
    const name = m[1];
    if (!AUTO_RESOLVED_VARS.has(name)) {
      vars.add(name);
    }
  }
  return [...vars];
}

/** Format variable name as a label. */
function varLabel(name: string): string {
  return VAR_LABELS[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ---------- Types ---------- */

interface TaskActionsProps {
  task: TaskRow;
  onRunTriggered?: (runId?: string) => void;
  onDeleted?: () => void;
  onCustomized?: (newTaskName: string) => void;
}

/* ---------- Component ---------- */

export function TaskActions({ task, onRunTriggered, onDeleted, onCustomized }: TaskActionsProps) {
  const triggerRun = useTriggerRun();
  const copyTask = useCopyTask();
  const deleteTask = useDeleteTask();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [instruction, setInstruction] = useState('');

  const templateVars = useMemo(
    () => extractTemplateVars(task.prompt ?? ''),
    [task.prompt],
  );

  const hasInputs = templateVars.length > 0;

  function handleRun() {
    // Build instruction from template vars + free-form instruction
    const parts: string[] = [];

    for (const v of templateVars) {
      const val = varValues[v]?.trim();
      if (val) {
        parts.push(`${v}: ${val}`);
      }
    }

    const freeform = instruction.trim();
    if (freeform) {
      parts.push(freeform);
    }

    const fullInstruction = parts.length > 0 ? parts.join('\n') : undefined;

    triggerRun.mutate(
      { task: task.name, instruction: fullInstruction },
      {
        onSuccess: (data) => {
          setDialogOpen(false);
          setVarValues({});
          setInstruction('');
          onRunTriggered?.(data.runId);
        },
      },
    );
  }

  function updateVar(name: string, value: string) {
    setVarValues(prev => ({ ...prev, [name]: value }));
  }

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        onClick={() => {
          if (hasInputs) {
            setDialogOpen(true);
          } else {
            // Still show dialog for instruction input
            setDialogOpen(true);
          }
        }}
      >
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

      {/* Run dialog — template variables + instruction */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run {task.displayName}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Template variable inputs */}
            {templateVars.map((v) => (
              <div key={v} className="space-y-1">
                <label className="font-sans text-sm font-medium text-on-surface">
                  {varLabel(v)}
                </label>
                <Input
                  value={varValues[v] ?? ''}
                  onChange={(e) => updateVar(v, e.target.value)}
                  placeholder={VAR_PLACEHOLDERS[v] ?? `Enter ${varLabel(v).toLowerCase()}`}
                  className="font-mono"
                  autoFocus={templateVars.indexOf(v) === 0}
                />
              </div>
            ))}

            {/* Free-form instruction */}
            <div className="space-y-1">
              <label className="font-sans text-sm font-medium text-on-surface">
                Instruction
                <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">(optional)</span>
              </label>
              <textarea
                className="w-full rounded-md bg-surface-container-lowest border border-[var(--ghost-border)] px-3 py-2 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/40 resize-none"
                rows={2}
                placeholder="Additional instructions for this run..."
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                disabled={triggerRun.isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={triggerRun.isPending}
              onClick={handleRun}
              className="gap-2"
            >
              {triggerRun.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
