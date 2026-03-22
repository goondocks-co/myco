import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConfig, type MycoConfig } from '../hooks/use-config';
import { useDaemon } from '../hooks/use-daemon';
import { fetchJson } from '../lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
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
}

function toFormState(config: MycoConfig): FormState {
  return {
    daemonPort: config.daemon.port != null ? String(config.daemon.port) : '',
    logLevel: config.daemon.log_level,
    embeddingProvider: config.embedding.provider,
    embeddingModel: config.embedding.model,
    embeddingBaseUrl: config.embedding.base_url ?? '',
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
  };
}

function isDirty(form: FormState, original: MycoConfig): boolean {
  const orig = toFormState(original);
  return (
    form.daemonPort !== orig.daemonPort ||
    form.logLevel !== orig.logLevel ||
    form.embeddingProvider !== orig.embeddingProvider ||
    form.embeddingModel !== orig.embeddingModel ||
    form.embeddingBaseUrl !== orig.embeddingBaseUrl
  );
}

export default function Settings() {
  const { config, isLoading, saveConfig, isSaving } = useConfig();
  const { data: stats } = useDaemon();

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
      setSaveMessage({ type: 'success', text: 'Settings saved.' });
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
      setTestMessage(`Connected — ${count} model${count !== 1 ? 's' : ''} available.`);
    } catch (err) {
      setTestState('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  };

  if (isLoading || !form || !config) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-2">Loading…</p>
      </div>
    );
  }

  const vaultName = stats?.vault.name ?? config.embedding.provider;

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Project section */}
      <Card>
        <CardHeader>
          <CardTitle>Project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Vault name — read-only */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Vault Name</label>
            <Input value={vaultName} readOnly disabled className="text-muted-foreground" />
          </div>

          {/* Daemon port */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Daemon Port</label>
            <Input
              type="number"
              placeholder="Auto"
              value={form.daemonPort}
              onChange={e => setField('daemonPort', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Leave blank to use a random available port.</p>
          </div>

          {/* Log level */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Log Level</label>
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
        </CardContent>
      </Card>

      {/* Embedding section */}
      <Card>
        <CardHeader>
          <CardTitle>Embedding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Provider */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Provider</label>
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
            <label className="text-sm font-medium">Model</label>
            <Input
              placeholder="bge-m3"
              value={form.embeddingModel}
              onChange={e => setField('embeddingModel', e.target.value)}
            />
          </div>

          {/* Base URL */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Base URL
              <span className="ml-1 text-xs text-muted-foreground font-normal">(optional)</span>
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
              variant="outline"
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
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="h-4 w-4" />
                {testMessage}
              </span>
            )}
            {testState === 'error' && (
              <span className="flex items-center gap-1 text-sm text-destructive">
                <XCircle className="h-4 w-4" />
                {testMessage}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

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
                ? 'text-sm text-green-600 dark:text-green-400'
                : 'text-sm text-destructive'
            }
          >
            {saveMessage.text}
          </span>
        )}
      </div>
    </div>
  );
}
