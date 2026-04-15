import { useState, useCallback } from 'react';
import {
  Settings2,
  Activity,
  Loader2,
} from 'lucide-react';
import { useDaemon, type StatsResponse } from '../../hooks/use-daemon';
import { useAgentTasks, type TaskRow } from '../../hooks/use-agent';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';
import { ScopedField } from '../config/ScopedField';
import { DEFAULT_SUMMARY_BATCH_INTERVAL } from '../../lib/constants';

/* ---------- Sub-components ---------- */

function MetricGauge({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const circumference = 2 * Math.PI * 36;
  const dashOffset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-20 w-20">
        <svg className="h-20 w-20 -rotate-90" viewBox="0 0 80 80">
          <circle
            cx="40" cy="40" r="36"
            fill="none"
            stroke="currentColor"
            className="text-surface-container/30"
            strokeWidth="6"
          />
          <circle
            cx="40" cy="40" r="36"
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-semibold font-mono text-on-surface">{pct}%</span>
        </div>
      </div>
      <span className="text-xs text-on-surface-variant text-center font-sans">{label}</span>
    </div>
  );
}

function StatRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-on-surface-variant font-sans">{label}</span>
      <span className="text-xs font-mono text-on-surface">{value}</span>
    </div>
  );
}

function SystemHealthSection({ stats }: { stats: StatsResponse }) {
  const embeddingCoverage = stats.embedding.total_embeddable > 0
    ? stats.embedding.embedded_count
    : 0;
  const embeddingTotal = stats.embedding.total_embeddable;

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold text-on-surface-variant uppercase tracking-widest flex items-center gap-2 font-sans">
        <Activity className="h-3.5 w-3.5" />
        System Health
      </h2>

      {/* Metric gauges */}
      <div className="flex justify-center gap-8 py-2">
        <MetricGauge
          label="Embedding Coverage"
          value={embeddingCoverage}
          max={embeddingTotal}
          color="#abcfb8"
        />
        <MetricGauge
          label="Queue Health"
          value={Math.max(0, embeddingTotal - stats.embedding.queue_depth)}
          max={embeddingTotal}
          color="#edbf7f"
        />
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-0">
        <StatRow label="Sessions" value={String(stats.vault.session_count)} />
        <StatRow label="Spores" value={String(stats.vault.spore_count)} />
        <StatRow label="Entities" value={String(stats.vault.entity_count)} />
        <StatRow label="Graph edges" value={String(stats.vault.edge_count)} />
        <StatRow label="Uptime" value={formatUptime(stats.daemon.uptime_seconds)} />
        <StatRow label="Daemon" value={`v${stats.daemon.version} :${stats.daemon.port}`} />
        {stats.agent.last_run_at !== null && (
          <>
            <StatRow label="Last run" value={formatEpochAgo(stats.agent.last_run_at)} />
            <StatRow label="Total runs" value={String(stats.agent.total_runs)} />
          </>
        )}
        {stats.digest.freshest_tier !== null && (
          <StatRow label="Digest tier" value={`T${stats.digest.freshest_tier}`} />
        )}
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export function AgentConfig() {
  const { effective, isLoading: configLoading } = useScopedConfig();
  const { data: stats, isLoading: statsLoading } = useDaemon();
  const { data: tasksData, isLoading: tasksLoading } = useAgentTasks();

  const tasks: TaskRow[] = tasksData?.tasks ?? [];
  const [selectedDefaultTask, setSelectedDefaultTask] = useState<string | null>(null);
  const defaultTaskFromApi = tasks.find((t) => t.isDefault)?.name ?? '';
  const defaultTask = selectedDefaultTask ?? defaultTaskFromApi;

  const handleDefaultTaskChange = useCallback((next: string) => {
    setSelectedDefaultTask(next);
    // Default-task selection is handled by a separate endpoint (agent tasks),
    // not by the scoped config — persistence of this selection is a TODO
    // tracked alongside the per-task override UI. For now it's session-only.
  }, []);

  const hasAgentProvider = !!effective?.agent?.provider;

  if (configLoading || !effective) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-md animate-pulse bg-surface-container-low" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ---------- Agent Operations (editable) ---------- */}
      <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
        <SectionHeader>
          <span className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            Agent Operations
          </span>
        </SectionHeader>

        {/* Global agent toggles — personal-default: each machine opts in independently */}
        <div className="space-y-3">
          <ScopedField
            path="agent.scheduled_tasks_enabled"
            label="Scheduled Tasks"
            defaultScope="local"
            hint="runs intelligence/skill-survey/skill-evolve on a cron"
          >
            {({ value, onChange }) => (
              <Switch
                checked={value ?? true}
                onCheckedChange={onChange}
                disabled={!hasAgentProvider}
              />
            )}
          </ScopedField>

          <ScopedField
            path="agent.event_tasks_enabled"
            label="Event-Driven Tasks"
            defaultScope="local"
            hint="titles + summaries on session end"
          >
            {({ value, onChange }) => (
              <Switch
                checked={value ?? true}
                onCheckedChange={onChange}
                disabled={!hasAgentProvider}
              />
            )}
          </ScopedField>
        </div>

        {!hasAgentProvider && (
          <p className="font-sans text-xs text-on-surface-variant/70">
            Configure an agent provider in{' '}
            <a href="/settings" className="underline hover:text-on-surface transition-colors">
              Settings
            </a>{' '}
            to enable agent tasks.
          </p>
        )}

        <div className="border-t border-outline-variant/20" />

        {/* Title & Summary batch interval — project-default (pipeline cadence is team-agreed) */}
        <ScopedField
          path="agent.summary_batch_interval"
          label="Title & Summary Batch Interval"
          defaultScope="project"
          commitOn="blur"
          hint="batches between event-driven summary triggers; 0 disables"
        >
          {({ value, onChange, onBlur }) => (
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                placeholder={String(DEFAULT_SUMMARY_BATCH_INTERVAL)}
                value={value ?? ''}
                onChange={(e) => onChange(Number(e.target.value))}
                onBlur={onBlur}
                className="w-32 font-mono"
              />
              <span className="font-sans text-xs text-on-surface-variant">batches</span>
            </div>
          )}
        </ScopedField>

        {/* Default task — persistence handled by a separate agent-tasks endpoint */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Default Task</label>
          {tasksLoading ? (
            <div className="flex h-9 items-center gap-2 text-on-surface-variant font-sans text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading tasks...
            </div>
          ) : (
            <Select value={defaultTask} onValueChange={handleDefaultTaskChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select default task" />
              </SelectTrigger>
              <SelectContent>
                {tasks.map((task) => (
                  <SelectItem key={task.name} value={task.name}>
                    {task.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="font-sans text-xs text-on-surface-variant">
            The task used when Run Now is clicked or no task is specified.
          </p>
        </div>
      </Surface>

      {/* ---------- System Health (read-only) ---------- */}
      {statsLoading ? (
        <Surface level="low" className="p-6">
          <div className="h-32 animate-pulse rounded-md bg-surface-container" />
        </Surface>
      ) : stats ? (
        <Surface level="low" className="p-6">
          <SystemHealthSection stats={stats} />
        </Surface>
      ) : null}
    </div>
  );
}
