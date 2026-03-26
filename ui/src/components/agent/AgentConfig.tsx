import { useState, useCallback, useRef } from 'react';
import {
  Settings2,
  Cpu,
  Activity,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { useConfig, type MycoConfig } from '../../hooks/use-config';
import { useDaemon, type StatsResponse } from '../../hooks/use-daemon';
import { useAgentTasks, type TaskRow } from '../../hooks/use-agent';
import { useRestart } from '../../hooks/use-restart';
import { fetchJson } from '../../lib/api';
import { formatUptime, formatEpochAgo } from '../../lib/format';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

/* ---------- Constants ---------- */

/** Minimum allowed interval in seconds. */
const MIN_INTERVAL_SECONDS = 30;

/** Default interval fallback. */
const DEFAULT_INTERVAL_SECONDS = 300;

/** Default summary batch interval. */
const DEFAULT_SUMMARY_BATCH_INTERVAL = 5;

/**
 * Parse a string to a number, returning `fallback` when the input is empty,
 * non-numeric, or NaN. Unlike `Number(s) || fallback`, this correctly handles
 * the value `0` (which is a valid input for "disabled" fields).
 */
function parseNumericField(value: string, fallback: number): number {
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

type TestState = 'idle' | 'testing' | 'success' | 'error';

/* ---------- Types ---------- */

interface AgentFormState {
  autoRun: boolean;
  intervalSeconds: string;
  summaryBatchInterval: string;
  defaultTask: string;
}

/* ---------- Helpers ---------- */

function toAgentForm(config: MycoConfig, defaultTaskName?: string): AgentFormState {
  return {
    autoRun: config.agent?.auto_run ?? true,
    intervalSeconds: String(config.agent?.interval_seconds ?? DEFAULT_INTERVAL_SECONDS),
    summaryBatchInterval: String(config.agent?.summary_batch_interval ?? DEFAULT_SUMMARY_BATCH_INTERVAL),
    defaultTask: defaultTaskName ?? '',
  };
}

function isAgentDirty(form: AgentFormState, config: MycoConfig, originalDefaultTask: string): boolean {
  const orig = toAgentForm(config, originalDefaultTask);
  return (
    form.autoRun !== orig.autoRun ||
    form.intervalSeconds !== orig.intervalSeconds ||
    form.summaryBatchInterval !== orig.summaryBatchInterval ||
    form.defaultTask !== orig.defaultTask
  );
}

function formatMinutes(seconds: string): string {
  const n = Number(seconds);
  if (isNaN(n) || n <= 0) return '';
  const m = n / 60;
  if (m < 1) return `${n}s`;
  if (Number.isInteger(m)) return `${m} min`;
  return `${m.toFixed(1)} min`;
}

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
  const { config, isLoading: configLoading, saveConfig, isSaving } = useConfig();
  const { data: stats, isLoading: statsLoading } = useDaemon();
  const { data: tasksData, isLoading: tasksLoading } = useAgentTasks();
  const { restart } = useRestart();

  const [form, setForm] = useState<AgentFormState | null>(null);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  const tasks: TaskRow[] = tasksData?.tasks ?? [];
  const defaultTaskFromApi = tasks.find((t) => t.isDefault)?.name ?? '';

  // Initialise form from config once config + tasks load. A ref tracks whether
  // we have initialised so we only seed once — subsequent refetches do NOT
  // overwrite user edits. This replaces the previous useEffect pattern.
  const formInitialised = useRef(false);
  if (config && !tasksLoading && !formInitialised.current) {
    formInitialised.current = true;
    if (form === null) {
      setForm(toAgentForm(config, defaultTaskFromApi));
    }
  }

  const dirty = form && config ? isAgentDirty(form, config, defaultTaskFromApi) : false;

  const setField = useCallback(<K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveMessage(null);
  }, []);

  const handleSave = async () => {
    if (!form || !config) return;
    setSaveMessage(null);
    try {
      const updated: MycoConfig = {
        ...config,
        agent: {
          auto_run: form.autoRun,
          interval_seconds: Math.max(MIN_INTERVAL_SECONDS, parseNumericField(form.intervalSeconds, DEFAULT_INTERVAL_SECONDS)),
          summary_batch_interval: parseNumericField(form.summaryBatchInterval, DEFAULT_SUMMARY_BATCH_INTERVAL),
        },
      };
      await saveConfig(updated);
      setSaveMessage({ type: 'success', text: 'Agent settings saved. Restarting daemon...' });
      try {
        await restart();
      } catch {
        setSaveMessage({ type: 'success', text: 'Settings saved. Daemon restart may require manual action.' });
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Failed to save settings.' });
    }
  };

  const handleTestEmbedding = async () => {
    if (!config) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const params = new URLSearchParams({
        provider: config.embedding.provider,
        type: 'embedding',
      });
      if (config.embedding.base_url) params.set('base_url', config.embedding.base_url);
      const result = await fetchJson<{ provider: string; models: string[] }>(
        `/models?${params.toString()}`,
      );
      const count = result.models.length;
      setTestState('success');
      setTestMessage(`Connected -- ${count} model${count !== 1 ? 's' : ''} available.`);
    } catch (err) {
      setTestState('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  };

  if (configLoading || !config || !form) {
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

        {/* Auto-run toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label className="font-sans text-sm font-medium text-on-surface">Auto Run</label>
            <p className="font-sans text-xs text-on-surface-variant">
              Automatically process unprocessed batches on a timer.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.autoRun}
            onClick={() => setField('autoRun', !form.autoRun)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 ${
              form.autoRun ? 'bg-primary' : 'bg-surface-container-high'
            }`}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-on-surface shadow-lg ring-0 transition-transform ${
                form.autoRun ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Run interval */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Run Interval</label>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={MIN_INTERVAL_SECONDS}
              placeholder={String(DEFAULT_INTERVAL_SECONDS)}
              value={form.intervalSeconds}
              onChange={(e) => setField('intervalSeconds', e.target.value)}
              className="w-32 font-mono"
            />
            <span className="font-sans text-xs text-on-surface-variant">
              seconds
              {form.intervalSeconds && (
                <span className="ml-1 text-on-surface">({formatMinutes(form.intervalSeconds)})</span>
              )}
            </span>
          </div>
          <p className="font-sans text-xs text-on-surface-variant">
            How often the agent checks for unprocessed work. Minimum {MIN_INTERVAL_SECONDS}s.
          </p>
        </div>

        {/* Summary batch interval */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Summary Batch Interval</label>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={0}
              placeholder={String(DEFAULT_SUMMARY_BATCH_INTERVAL)}
              value={form.summaryBatchInterval}
              onChange={(e) => setField('summaryBatchInterval', e.target.value)}
              className="w-32 font-mono"
            />
            <span className="font-sans text-xs text-on-surface-variant">batches</span>
          </div>
          <p className="font-sans text-xs text-on-surface-variant">
            Trigger a session summary every N batches. Set to 0 to disable.
          </p>
        </div>

        {/* Default task */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Default Task</label>
          {tasksLoading ? (
            <div className="flex h-9 items-center gap-2 text-on-surface-variant font-sans text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading tasks...
            </div>
          ) : (
            <Select
              value={form.defaultTask}
              onValueChange={(v) => setField('defaultTask', v)}
            >
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
            The task used when auto-run triggers or no task is specified.
          </p>
        </div>

        {/* Save row */}
        <div className="flex items-center gap-3 pt-2 border-t border-outline-variant/20">
          <Button
            onClick={handleSave}
            disabled={!dirty || isSaving}
            size="sm"
          >
            {isSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Save Changes
          </Button>
          {saveMessage && (
            <span
              className={
                saveMessage.type === 'success'
                  ? 'font-sans text-xs text-primary'
                  : 'font-sans text-xs text-tertiary'
              }
            >
              {saveMessage.text}
            </span>
          )}
        </div>
      </Surface>

      {/* ---------- Embedding Configuration (read-only summary + link) ---------- */}
      <Surface level="low" className="p-6 space-y-4 border-t-2 border-t-ochre">
        <SectionHeader>
          <span className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-secondary" />
            Embedding Configuration
          </span>
        </SectionHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <div>
            <p className="font-sans text-xs text-on-surface-variant">Provider</p>
            <p className="text-sm font-mono text-on-surface mt-0.5">
              {config.embedding.provider}
            </p>
          </div>
          <div>
            <p className="font-sans text-xs text-on-surface-variant">Model</p>
            <p className="text-sm font-mono text-on-surface mt-0.5 truncate" title={config.embedding.model}>
              {config.embedding.model}
            </p>
          </div>
          {config.embedding.base_url && (
            <div className="col-span-2">
              <p className="font-sans text-xs text-on-surface-variant">Base URL</p>
              <p className="text-sm font-mono text-on-surface mt-0.5 truncate" title={config.embedding.base_url}>
                {config.embedding.base_url}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-outline-variant/20">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleTestEmbedding}
            disabled={testState === 'testing'}
          >
            {testState === 'testing' ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Test Connection
          </Button>
          <a
            href="/settings"
            className="flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Edit in Settings
          </a>
          {testState === 'success' && (
            <span className="flex items-center gap-1 font-sans text-xs text-primary">
              <CheckCircle className="h-3.5 w-3.5" />
              {testMessage}
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 font-sans text-xs text-tertiary">
              <XCircle className="h-3.5 w-3.5" />
              {testMessage}
            </span>
          )}
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
