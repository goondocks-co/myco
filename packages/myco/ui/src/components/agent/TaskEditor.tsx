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
    return <div className="h-64 animate-pulse rounded-md bg-surface-container-low" />;
  }

  if (isError) {
    return (
      <div className="rounded-md bg-tertiary-container/20 p-4 font-sans text-sm text-tertiary">
        Failed to load task YAML.
      </div>
    );
  }

  const isReadOnly = data?.source !== 'user';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
          Task Definition {isReadOnly && '(read-only)'}
        </h2>
        {!isReadOnly && (
          <div className="flex gap-2">
            <Button
              variant="ghost"
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
        className={`w-full rounded-md bg-surface-container-lowest p-4 font-mono text-sm text-on-surface leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/40 ${
          isReadOnly ? 'opacity-75 cursor-not-allowed' : ''
        }`}
      />

      {updateTask.isError && (
        <div className="rounded-md bg-tertiary-container/20 p-3 font-sans text-sm text-tertiary">
          {updateTask.error.message}
        </div>
      )}

      {updateTask.isSuccess && !dirty && (
        <div className="rounded-md bg-primary-container/20 p-3 font-sans text-sm text-primary">
          Task saved successfully.
        </div>
      )}
    </div>
  );
}
