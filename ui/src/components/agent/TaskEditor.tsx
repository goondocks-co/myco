import { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { useTaskYaml, useUpdateTask } from '../../hooks/use-agent';

/* ---------- Constants ---------- */

/** Minimum height for the YAML editor textarea. */
const EDITOR_MIN_ROWS = 20;

/* ---------- Types ---------- */

interface TaskEditorProps {
  taskId: string;
  onSaved?: () => void;
}

/* ---------- Component ---------- */

export function TaskEditor({ taskId, onSaved }: TaskEditorProps) {
  const { data, isLoading, isError } = useTaskYaml(taskId);
  const updateTask = useUpdateTask();
  const [yaml, setYaml] = useState('');
  const [dirty, setDirty] = useState(false);

  // Sync editor content when data loads
  useEffect(() => {
    if (data?.yaml) {
      setYaml(data.yaml);
      setDirty(false);
    }
  }, [data?.yaml]);

  function handleChange(value: string) {
    setYaml(value);
    setDirty(true);
  }

  function handleSave() {
    updateTask.mutate(
      { taskId, yaml },
      {
        onSuccess: () => {
          setDirty(false);
          onSaved?.();
        },
      },
    );
  }

  function handleReset() {
    if (data?.yaml) {
      setYaml(data.yaml);
      setDirty(false);
    }
  }

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted" />;
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load task YAML.
      </div>
    );
  }

  const isReadOnly = data?.source !== 'user';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Task Definition {isReadOnly && '(read-only)'}
        </h2>
        {!isReadOnly && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={!dirty}
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || updateTask.isPending}
            >
              {updateTask.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      <textarea
        value={yaml}
        onChange={(e) => handleChange(e.target.value)}
        readOnly={isReadOnly}
        rows={EDITOR_MIN_ROWS}
        spellCheck={false}
        className={`w-full rounded-lg border bg-muted p-4 font-mono text-sm text-foreground leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring ${
          isReadOnly ? 'opacity-75 cursor-not-allowed' : ''
        }`}
      />

      {updateTask.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {updateTask.error.message}
        </div>
      )}

      {updateTask.isSuccess && !dirty && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 text-sm text-green-700 dark:text-green-400">
          Task saved successfully.
        </div>
      )}
    </div>
  );
}
