import { useMemo, useState } from 'react';
import { useAgentTasks, useTask } from '../../hooks/use-agent';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { getInheritedExecution } from '../../hooks/use-providers';
import { TaskProviderConfig } from '../agent/TaskProviderConfig';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

/**
 * The per-task table (server-mode design spec §6.3), mounted inside a
 * `TeamConfigTargetProvider` by `TeamSettingsPanel`. A minimal task picker
 * over the reused, UNMODIFIED `TaskProviderConfig` — its bespoke
 * `useTaskConfig`/`useUpdateTaskConfig` hooks already branch to the
 * `/team/agent-tasks/:id/config` team-write route when a team target is
 * bound (`use-providers.ts`), so this wrapper only needs to supply which
 * task is selected and its (task-definition-only, never grove-scoped)
 * phases/schedule/params/defaults — the SAME shape `TaskDetail` builds for
 * the project-scoped page.
 *
 * Task LISTING/DETAIL (`useAgentTasks`/`useTask`) stay unscoped — task
 * definitions are build-vendored YAML, identical across daemons on the same
 * version, never served-grove data — matching how the provider-detection
 * hooks (`useProviders`) already stay unscoped in team mode.
 */
export function TeamTaskProviderConfig() {
  const { data: tasksData, isPending: isLoadingTasks } = useAgentTasks();
  const tasks = tasksData?.tasks ?? [];
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined);
  const effectiveTaskId = selectedTaskId ?? tasks[0]?.name;

  const { data: taskDetail } = useTask(effectiveTaskId);
  const { effective } = useScopedConfig();
  const task = taskDetail?.task;
  const inherited = task ? getInheritedExecution(task, effective) : undefined;

  const defaults = useMemo(() => (inherited ? {
    harness: inherited.harness,
    providerType: inherited.providerType,
    localBackend: inherited.localBackend,
    reasoningLevel: inherited.reasoningLevel,
    reasoningMap: inherited.reasoningMap,
    model: inherited.model,
    baseUrl: inherited.baseUrl,
    contextLength: inherited.contextLength,
    maxTurns: inherited.maxTurns,
    timeoutSeconds: inherited.timeoutSeconds,
  } : undefined), [inherited]);

  if (isLoadingTasks) {
    return <p className="text-sm text-on-surface-variant m-0">Loading tasks…</p>;
  }

  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <Select value={effectiveTaskId} onValueChange={setSelectedTaskId}>
        <SelectTrigger>
          <SelectValue placeholder="Select a task" />
        </SelectTrigger>
        <SelectContent>
          {tasks.map((t) => (
            <SelectItem key={t.name} value={t.name}>
              {t.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {task && effectiveTaskId && (
        <TaskProviderConfig
          taskId={effectiveTaskId}
          phases={task.phases}
          defaults={defaults}
          schedule={task.schedule}
          params={task.params}
        />
      )}
    </div>
  );
}

export default TeamTaskProviderConfig;
