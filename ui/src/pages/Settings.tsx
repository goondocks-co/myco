import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConfig, type MycoConfig } from '../hooks/use-config';
import { useDaemon } from '../hooks/use-daemon';
import { useRestart } from '../hooks/use-restart';
import { fetchJson } from '../lib/api';
import { Surface } from '../components/ui/surface';
import { PageHeader } from '../components/ui/page-header';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Provider = 'ollama' | 'openai-compatible';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

type TestState = 'idle' | 'testing' | 'success' | 'error';

interface FormState {
  daemonPort: string;
  logLevel: LogLevel;
  embeddingProvider: Provider;
  embeddingModel: string;
  embeddingBaseUrl: string;
  agentAutoRun: boolean;
  agentIntervalSeconds: string;
  agentSummaryBatchInterval: string;
}

function toFormState(config: MycoConfig): FormState {
  return {
    daemonPort: config.daemon.port != null ? String(config.daemon.port) : '',
    logLevel: config.daemon.log_level,
    embeddingProvider: config.embedding.provider,
    embeddingModel: config.embedding.model,
    embeddingBaseUrl: config.embedding.base_url ?? '',
    agentAutoRun: config.agent?.auto_run ?? true,
    agentIntervalSeconds: String(config.agent?.interval_seconds ?? 300),
    agentSummaryBatchInterval: String(config.agent?.summary_batch_interval ?? 5),
  };
}

function formToConfig(form: FormState, original: MycoConfig): MycoConfig {
  return {
    ...original,
    daemon: {
      ...original.daemon,
      port: form.daemonPort !== '' ? Number(form.daemonPort) : null,
      log_level: form.logLevel,
    },
    embedding: {
      provider: form.embeddingProvider,
      model: form.embeddingModel,
      base_url: form.embeddingBaseUrl !== '' ? form.embeddingBaseUrl : undefined,
    },
    agent: {
      auto_run: form.agentAutoRun,
      interval_seconds: Number(form.agentIntervalSeconds) || 300,
      summary_batch_interval: Number(form.agentSummaryBatchInterval) ?? 5,
    },
  };
}

function isDirty(form: FormState, original: MycoConfig): boolean {
  const orig = toFormState(original);
  return (
    form.daemonPort !== orig.daemonPort ||
    form.logLevel !== orig.logLevel ||
    form.embeddingProvider !== orig.embeddingProvider ||
    form.embeddingModel !== orig.embeddingModel ||
    form.embeddingBaseUrl !== orig.embeddingBaseUrl ||
    form.agentAutoRun !== orig.agentAutoRun ||
    form.agentIntervalSeconds !== orig.agentIntervalSeconds ||
    form.agentSummaryBatchInterval !== orig.agentSummaryBatchInterval
  );
}

export default function Settings() {
  const { config, isLoading, saveConfig, isSaving } = useConfig();
  const { data: stats } = useDaemon();
  const { restart } = useRestart();

  const [form, setForm] = useState<FormState | null>(null);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState<string>('');

  // Initialise form when config loads (only once)
  useEffect(() => {
    if (config && form === null) {
      setForm(toFormState(config));
    }
  }, [config, form]);

  const dirty = form && config ? isDirty(form, config) : false;

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaveMessage(null);
  }, []);

  const handleSave = async () => {
    if (!form || !config) return;
    setSaveMessage(null);
    try {
      await saveConfig(formToConfig(form, config));
      setSaveMessage({ type: 'success', text: 'Settings saved. Restarting daemon...' });
      // Trigger daemon restart so new settings take effect
      try {
        await restart();
      } catch {
        // Restart may fail if daemon is already restarting; the save still succeeded
        setSaveMessage({ type: 'success', text: 'Settings saved. Daemon restart may require manual action.' });
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Failed to save settings.' });
    }
  };

  const handleTestConnection = async () => {
    if (!form) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const params = new URLSearchParams({ provider: form.embeddingProvider, type: 'embedding' });
      if (form.embeddingBaseUrl) params.set('base_url', form.embeddingBaseUrl);
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

  if (isLoading || !form || !config) {
    return (
      <div className="p-6">
        <PageHeader title="Settings" />
        <p className="font-sans text-sm text-on-surface-variant mt-2">Loading...</p>
      </div>
    );
  }

  const vaultName = stats?.vault.name ?? config.embedding.provider;

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Settings" />

      {/* Project section */}
      <Surface level="low" className="p-6 space-y-4">
        <h2 className="font-sans text-base font-medium text-on-surface">Project</h2>

        {/* Vault name -- read-only */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Vault Name</label>
          <Input value={vaultName} readOnly disabled className="text-on-surface-variant" />
        </div>

        {/* Daemon port */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Daemon Port</label>
          <Input
            type="number"
            placeholder="Auto"
            value={form.daemonPort}
            onChange={e => setField('daemonPort', e.target.value)}
          />
          <p className="font-sans text-xs text-on-surface-variant">Leave blank to use a random available port.</p>
        </div>

        {/* Log level */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Log Level</label>
          <Select
            value={form.logLevel}
            onValueChange={v => setField('logLevel', v as LogLevel)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.map(level => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Surface>

      {/* Embedding section */}
      <Surface level="low" className="p-6 space-y-4">
        <h2 className="font-sans text-base font-medium text-on-surface">Embedding</h2>

        {/* Provider */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Provider</label>
          <Select
            value={form.embeddingProvider}
            onValueChange={v => {
              setField('embeddingProvider', v as Provider);
              setTestState('idle');
              setTestMessage('');
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map(p => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Model */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Model</label>
          <Input
            placeholder="bge-m3"
            value={form.embeddingModel}
            onChange={e => setField('embeddingModel', e.target.value)}
          />
        </div>

        {/* Base URL */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">
            Base URL
            <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">(optional)</span>
          </label>
          <Input
            type="url"
            placeholder="http://localhost:11434"
            value={form.embeddingBaseUrl}
            onChange={e => {
              setField('embeddingBaseUrl', e.target.value);
              setTestState('idle');
              setTestMessage('');
            }}
          />
        </div>

        {/* Test Connection */}
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleTestConnection}
            disabled={testState === 'testing'}
          >
            {testState === 'testing' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Test Connection
          </Button>
          {testState === 'success' && (
            <span className="flex items-center gap-1 font-sans text-sm text-primary">
              <CheckCircle className="h-4 w-4" />
              {testMessage}
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 font-sans text-sm text-tertiary">
              <XCircle className="h-4 w-4" />
              {testMessage}
            </span>
          )}
        </div>
      </Surface>

      {/* Agent section */}
      <Surface level="low" className="p-6 space-y-4">
        <h2 className="font-sans text-base font-medium text-on-surface">Agent</h2>

        {/* Auto-run toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label className="font-sans text-sm font-medium text-on-surface">Auto Run</label>
            <p className="font-sans text-xs text-on-surface-variant">
              Automatically run the agent on unprocessed batches.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.agentAutoRun}
            onClick={() => setField('agentAutoRun', !form.agentAutoRun)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 ${
              form.agentAutoRun ? 'bg-primary' : 'bg-surface-container-high'
            }`}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-on-surface shadow-lg ring-0 transition-transform ${
                form.agentAutoRun ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Interval */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Run Interval (seconds)</label>
          <Input
            type="number"
            min="30"
            placeholder="300"
            value={form.agentIntervalSeconds}
            onChange={e => setField('agentIntervalSeconds', e.target.value)}
          />
          <p className="font-sans text-xs text-on-surface-variant">
            Seconds between agent timer checks. Minimum 30.
          </p>
        </div>

        {/* Summary batch interval */}
        <div className="space-y-1">
          <label className="font-sans text-sm font-medium text-on-surface">Summary Batch Interval</label>
          <Input
            type="number"
            min="0"
            placeholder="5"
            value={form.agentSummaryBatchInterval}
            onChange={e => setField('agentSummaryBatchInterval', e.target.value)}
          />
          <p className="font-sans text-xs text-on-surface-variant">
            Trigger a session summary every N batches. Set to 0 to disable.
          </p>
        </div>
      </Surface>

      {/* Save row */}
      <div className="flex items-center gap-4">
        <Button onClick={handleSave} disabled={!dirty || isSaving}>
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save Settings
        </Button>
        {saveMessage && (
          <span
            className={
              saveMessage.type === 'success'
                ? 'font-sans text-sm text-primary'
                : 'font-sans text-sm text-tertiary'
            }
          >
            {saveMessage.text}
          </span>
        )}
      </div>
    </div>
  );
}
