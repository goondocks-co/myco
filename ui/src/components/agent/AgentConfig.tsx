import { useState, useMemo } from 'react';
import { FolderOpen, FileText, ChevronRight, ChevronDown, ToggleLeft, ToggleRight } from 'lucide-react';
import { useConfig } from '../../hooks/use-config';
import { useDaemon, type StatsResponse } from '../../hooks/use-daemon';
import { useAgentTasks, type TaskRow } from '../../hooks/use-agent';
import { Surface } from '../ui/surface';
import { MetricGauge } from './MetricGauge';
import { MetricCard } from './MetricCard';
import { PromptViewer } from './PromptViewer';
import { ConfigSliders, type SliderConfig } from './ConfigSliders';
import { cn } from '../../lib/cn';
import { formatUptime } from '../../lib/format';

/* ---------- Constants ---------- */

/** Max interval seconds for the agent run interval slider. */
const MAX_INTERVAL_SECONDS = 900;

/** Min interval seconds for the agent run interval slider. */
const MIN_INTERVAL_SECONDS = 60;

/** Interval step for the slider. */
const INTERVAL_STEP = 30;

/** Max batch interval for the summary batch slider. */
const MAX_BATCH_INTERVAL = 20;

/** Simulated system load ceiling for gauge normalization. */
const SYSTEM_LOAD_CEILING = 100;

/** Number of sample sparkline points to generate from daemon stats. */
const SPARKLINE_SAMPLE_COUNT = 12;

/* ---------- Helpers ---------- */

/** Build a simple simulated sparkline from a seed value. */
function simulateSparkline(seed: number, count: number): number[] {
  const points: number[] = [];
  let current = seed;
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-variation based on index
    current = current + Math.sin(i * 1.3 + seed) * (seed * 0.1);
    points.push(Math.max(0, current));
  }
  return points;
}

/** Build prompt file tree from available tasks. */
interface PromptFile {
  name: string;
  taskName: string;
  isDefault: boolean;
}

function buildPromptFiles(tasks: TaskRow[]): PromptFile[] {
  return tasks.map((t) => ({
    name: `${t.name}.md`,
    taskName: t.name,
    isDefault: t.isDefault,
  }));
}

/** Format seconds as human-readable interval. */
function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/* ---------- Sub-components ---------- */

function PromptFileTree({
  files,
  selectedFile,
  onSelect,
}: {
  files: PromptFile[];
  selectedFile: string | null;
  onSelect: (taskName: string) => void;
}) {
  const [folderOpen, setFolderOpen] = useState(true);

  return (
    <div className="space-y-1">
      <button
        onClick={() => setFolderOpen(!folderOpen)}
        className="flex items-center gap-1.5 w-full px-2 py-1 rounded-sm hover:bg-surface-container-high/50 transition-colors"
      >
        {folderOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />
        )}
        <FolderOpen className="h-3.5 w-3.5 text-secondary" />
        <span className="font-sans text-xs font-medium text-on-surface">TASK_PROMPTS</span>
      </button>

      {folderOpen && (
        <div className="ml-5 space-y-0.5">
          {files.map((file) => (
            <button
              key={file.taskName}
              onClick={() => onSelect(file.taskName)}
              className={cn(
                'flex items-center gap-1.5 w-full px-2 py-1 rounded-sm transition-colors',
                selectedFile === file.taskName
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-surface-container-high/50 text-on-surface-variant hover:text-on-surface',
              )}
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="font-mono text-xs truncate">{file.name}</span>
              {file.isDefault && (
                <span className="ml-auto font-sans text-[10px] text-primary opacity-70">default</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AutoRunToggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="flex items-center justify-between gap-3 w-full px-3 py-2 rounded-md bg-surface-container-low hover:bg-surface-container transition-colors disabled:opacity-50"
    >
      <div className="flex flex-col items-start">
        <span className="font-sans text-xs font-medium text-on-surface">Autonomous Agent</span>
        <span className="font-sans text-[10px] text-on-surface-variant">
          {enabled ? 'Running on schedule' : 'Manual trigger only'}
        </span>
      </div>
      {enabled ? (
        <ToggleRight className="h-5 w-5 text-primary shrink-0" />
      ) : (
        <ToggleLeft className="h-5 w-5 text-on-surface-variant shrink-0" />
      )}
    </button>
  );
}

function SystemMetricsPanel({ stats }: { stats: StatsResponse | undefined }) {
  if (!stats) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-md bg-surface-container-low" />
        ))}
      </div>
    );
  }

  const embeddingRatio = stats.embedding.total_embeddable > 0
    ? stats.embedding.embedded_count / stats.embedding.total_embeddable
    : 0;
  const queueRatio = Math.min(1, stats.embedding.queue_depth / Math.max(1, stats.embedding.total_embeddable));

  // Simulated sparkline data from real metrics
  const sessionSparkline = simulateSparkline(stats.vault.session_count, SPARKLINE_SAMPLE_COUNT);
  const sporeSparkline = simulateSparkline(stats.vault.spore_count, SPARKLINE_SAMPLE_COUNT);

  return (
    <div className="space-y-4">
      {/* Gauges row */}
      <div className="grid grid-cols-2 gap-3">
        <MetricGauge
          value={embeddingRatio}
          label="Embedding Coverage"
          displayValue={`${Math.round(embeddingRatio * SYSTEM_LOAD_CEILING)}%`}
        />
        <MetricGauge
          value={1 - queueRatio}
          label="Queue Health"
          displayValue={stats.embedding.queue_depth === 0 ? 'Clear' : String(stats.embedding.queue_depth)}
        />
      </div>

      {/* Metric cards */}
      <MetricCard
        label="Signal Activity"
        value={`${stats.vault.spore_count} spores`}
        sparklineData={sporeSparkline}
      />

      <MetricCard
        label="Session Archive"
        value={`${stats.vault.session_count} sessions`}
        sparklineData={sessionSparkline}
      />

      <MetricCard
        label="Daemon Uptime"
        value={formatUptime(stats.daemon.uptime_seconds)}
      />

      <MetricCard
        label="Entities / Edges"
        value={`${stats.vault.entity_count} / ${stats.vault.edge_count}`}
      />

      {stats.digest.freshest_tier !== null && (
        <MetricCard
          label="Digest Tier"
          value={`T${stats.digest.freshest_tier}`}
        />
      )}
    </div>
  );
}

/* ---------- Main Component ---------- */

export function AgentConfig() {
  const { config, isLoading: configLoading } = useConfig();
  const { data: stats } = useDaemon();
  const { data: tasksData } = useAgentTasks();

  const [selectedTask, setSelectedTask] = useState<string | null>(null);

  const tasks = tasksData?.tasks ?? [];
  const promptFiles = useMemo(() => buildPromptFiles(tasks), [tasks]);

  // Resolve selected task content
  const activeTask = tasks.find((t) => t.name === selectedTask);
  const defaultTask = tasks.find((t) => t.isDefault);

  // Auto-select default task if nothing selected
  const effectiveTask = activeTask ?? defaultTask;
  const effectiveTaskName = effectiveTask?.name ?? null;

  // Build prompt content to display
  const promptContent = useMemo(() => {
    if (!effectiveTask) return '';
    if (effectiveTask.phases && effectiveTask.phases.length > 0) {
      return effectiveTask.phases
        .map((p, i) => `## Phase ${i + 1}: ${p.name}\n\n${p.prompt}\n\nTools: ${p.tools.join(', ') || 'all'}\nMax turns: ${p.maxTurns}${p.required ? '' : ' (optional)'}`)
        .join('\n\n---\n\n');
    }
    return effectiveTask.prompt || 'No prompt defined.';
  }, [effectiveTask]);

  // Config sliders
  const sliders: SliderConfig[] = useMemo(() => {
    if (!config) return [];
    return [
      {
        id: 'interval',
        label: 'Run Interval',
        value: config.agent?.interval_seconds ?? 300,
        min: MIN_INTERVAL_SECONDS,
        max: MAX_INTERVAL_SECONDS,
        step: INTERVAL_STEP,
        formatValue: formatInterval,
      },
      {
        id: 'batchInterval',
        label: 'Summary Batch Size',
        value: config.agent?.summary_batch_interval ?? 5,
        min: 1,
        max: MAX_BATCH_INTERVAL,
        step: 1,
        formatValue: (v: number) => `${v} sessions`,
      },
    ];
  }, [config]);

  if (configLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_300px] gap-4">
        <div className="h-96 animate-pulse rounded-md bg-surface-container-low" />
        <div className="h-96 animate-pulse rounded-md bg-surface-container-lowest" />
        <div className="h-96 animate-pulse rounded-md bg-surface-container-low" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_300px] gap-4">
      {/* Left column — System Prompts & Config */}
      <div className="space-y-4">
        <Surface level="low" className="p-3">
          <h3 className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide mb-3 px-1">
            System Prompts
          </h3>
          <PromptFileTree
            files={promptFiles}
            selectedFile={effectiveTaskName}
            onSelect={setSelectedTask}
          />
        </Surface>

        <Surface level="low" className="p-4">
          <h3 className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide mb-4">
            Agent Parameters
          </h3>
          <ConfigSliders sliders={sliders} disabled />
        </Surface>

        {config && (
          <AutoRunToggle
            enabled={config.agent?.auto_run ?? true}
            onToggle={() => {/* read-only for now */}}
            disabled
          />
        )}

        {/* Embedding config summary */}
        <Surface level="low" className="p-3 space-y-2">
          <h3 className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
            Embedding
          </h3>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-sans text-xs text-on-surface-variant">Provider</span>
              <span className="font-mono text-xs text-on-surface">{config?.embedding.provider ?? '--'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-sans text-xs text-on-surface-variant">Model</span>
              <span className="font-mono text-xs text-on-surface truncate max-w-[140px]">{config?.embedding.model ?? '--'}</span>
            </div>
          </div>
        </Surface>
      </div>

      {/* Center column — Prompt Viewer */}
      <Surface level="lowest" className="overflow-hidden">
        <PromptViewer
          content={promptContent}
          title={effectiveTask?.displayName ?? 'Select a task'}
          filename={effectiveTask ? `${effectiveTask.name}.md` : undefined}
        />
      </Surface>

      {/* Right column — System Metrics */}
      <div className="space-y-3">
        <h3 className="font-serif text-base font-normal text-on-surface tracking-wide">
          System Metrics
        </h3>
        <SystemMetricsPanel stats={stats} />
      </div>
    </div>
  );
}
