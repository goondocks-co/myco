import { useState, useEffect, useCallback } from 'react';
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
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
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
            className="text-muted/30"
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
          <span className="text-sm font-semibold font-mono text-foreground">{pct}%</span>
        </div>
      </div>
      <span className="text-xs text-muted-foreground text-center">{label}</span>
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
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono text-foreground">{value}</span>
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
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
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

  // Initialise form once config + tasks load
  useEffect(() => {
    if (config && form === null && !tasksLoading) {
      setForm(toAgentForm(config, defaultTaskFromApi));
    }
  }, [config, form, tasksLoading, defaultTaskFromApi]);

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
          interval_seconds: Math.max(MIN_INTERVAL_SECONDS, Number(form.intervalSeconds) || DEFAULT_INTERVAL_SECONDS),
          summary_batch_interval: Number(form.summaryBatchInterval) ?? DEFAULT_SUMMARY_BATCH_INTERVAL,
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
          <div key={i} className="h-32 rounded-lg border animate-pulse bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ---------- Agent Operations (editable) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Settings2 className="h-4 w-4 text-[#abcfb8]" />
            Agent Operations
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Auto-run toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <label className="text-sm font-medium">Auto Run</label>
              <p className="text-xs text-muted-foreground">
                Automatically process unprocessed batches on a timer.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.autoRun}
              onClick={() => setField('autoRun', !form.autoRun)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                form.autoRun ? 'bg-[#abcfb8]' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                  form.autoRun ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Run interval */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Run Interval</label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={MIN_INTERVAL_SECONDS}
                placeholder={String(DEFAULT_INTERVAL_SECONDS)}
                value={form.intervalSeconds}
                onChange={(e) => setField('intervalSeconds', e.target.value)}
                className="w-32 font-mono"
              />
              <span className="text-xs text-muted-foreground">
                seconds
                {form.intervalSeconds && (
                  <span className="ml-1 text-foreground">({formatMinutes(form.intervalSeconds)})</span>
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              How often the agent checks for unprocessed work. Minimum {MIN_INTERVAL_SECONDS}s.
            </p>
          </div>

          {/* Summary batch interval */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Summary Batch Interval</label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                placeholder={String(DEFAULT_SUMMARY_BATCH_INTERVAL)}
                value={form.summaryBatchInterval}
                onChange={(e) => setField('summaryBatchInterval', e.target.value)}
                className="w-32 font-mono"
              />
              <span className="text-xs text-muted-foreground">batches</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Trigger a session summary every N batches. Set to 0 to disable.
            </p>
          </div>

          {/* Default task */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Default Task</label>
            {tasksLoading ? (
              <div className="flex h-9 items-center gap-2 text-muted-foreground text-sm">
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
            <p className="text-xs text-muted-foreground">
              The task used when auto-run triggers or no task is specified.
            </p>
          </div>

          {/* Save row */}
          <div className="flex items-center gap-3 pt-2 border-t border-border">
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
                    ? 'text-xs text-green-600 dark:text-green-400'
                    : 'text-xs text-destructive'
                }
              >
                {saveMessage.text}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------- Embedding Configuration (read-only summary + link) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Cpu className="h-4 w-4 text-[#edbf7f]" />
            Embedding Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <div>
              <p className="text-xs text-muted-foreground">Provider</p>
              <p className="text-sm font-mono text-foreground mt-0.5">
                {config.embedding.provider}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Model</p>
              <p className="text-sm font-mono text-foreground mt-0.5 truncate" title={config.embedding.model}>
                {config.embedding.model}
              </p>
            </div>
            {config.embedding.base_url && (
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">Base URL</p>
                <p className="text-sm font-mono text-foreground mt-0.5 truncate" title={config.embedding.base_url}>
                  {config.embedding.base_url}
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <Button
              type="button"
              variant="outline"
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
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              Edit in Settings
            </a>
            {testState === 'success' && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <CheckCircle className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
            {testState === 'error' && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------- System Health (read-only) ---------- */}
      {statsLoading ? (
        <Card>
          <CardContent className="p-6">
            <div className="h-32 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ) : stats ? (
        <Card>
          <CardContent className="p-6">
            <SystemHealthSection stats={stats} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
