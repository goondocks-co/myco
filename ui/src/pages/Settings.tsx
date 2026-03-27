import { useState, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConfig, type MycoConfig } from '../hooks/use-config';
import { useDaemon } from '../hooks/use-daemon';
import { useRestart } from '../hooks/use-restart';
import { fetchJson } from '../lib/api';
import { parseNumericField } from '../lib/format';
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_SUMMARY_BATCH_INTERVAL, DEFAULT_DIGEST_TIER, DEFAULT_MAX_SPORES } from '../lib/constants';
import { Surface } from '../components/ui/surface';
import { PageHeader } from '../components/ui/page-header';
import { SectionHeader } from '../components/ui/section-header';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Switch } from '../components/ui/switch';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Provider = 'ollama' | 'openai-compatible';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

const DIGEST_TIERS: { value: string; label: string }[] = [
  { value: '1500', label: '1.5K — Executive briefing' },
  { value: '3000', label: '3K — Team standup' },
  { value: '5000', label: '5K — Deep onboarding' },
  { value: '7500', label: '7.5K — Comprehensive' },
  { value: '10000', label: '10K — Full institutional' },
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
  contextDigestTier: string;
  contextPromptSearch: boolean;
  contextMaxSpores: string;
}

function toFormState(config: MycoConfig): FormState {
  return {
    daemonPort: config.daemon.port != null ? String(config.daemon.port) : '',
    logLevel: config.daemon.log_level,
    embeddingProvider: config.embedding.provider,
    embeddingModel: config.embedding.model,
    embeddingBaseUrl: config.embedding.base_url ?? '',
    agentAutoRun: config.agent?.auto_run ?? true,
    agentIntervalSeconds: String(config.agent?.interval_seconds ?? DEFAULT_INTERVAL_SECONDS),
    agentSummaryBatchInterval: String(config.agent?.summary_batch_interval ?? DEFAULT_SUMMARY_BATCH_INTERVAL),
    contextDigestTier: String(config.context?.digest_tier ?? DEFAULT_DIGEST_TIER),
    contextPromptSearch: config.context?.prompt_search ?? true,
    contextMaxSpores: String(config.context?.prompt_max_spores ?? DEFAULT_MAX_SPORES),
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
      interval_seconds: parseNumericField(form.agentIntervalSeconds, DEFAULT_INTERVAL_SECONDS),
      summary_batch_interval: parseNumericField(form.agentSummaryBatchInterval, DEFAULT_SUMMARY_BATCH_INTERVAL),
    },
    context: {
      digest_tier: parseNumericField(form.contextDigestTier, DEFAULT_DIGEST_TIER),
      prompt_search: form.contextPromptSearch,
      prompt_max_spores: parseNumericField(form.contextMaxSpores, DEFAULT_MAX_SPORES),
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
    form.agentSummaryBatchInterval !== orig.agentSummaryBatchInterval ||
    form.contextDigestTier !== orig.contextDigestTier ||
    form.contextPromptSearch !== orig.contextPromptSearch ||
    form.contextMaxSpores !== orig.contextMaxSpores
  );
}

/* ---------- Sub-components ---------- */

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="font-sans text-sm font-medium text-on-surface">
      {children}
      {hint && (
        <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">({hint})</span>
      )}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="font-sans text-xs text-on-surface-variant">{children}</p>;
}

/* ---------- Page ---------- */

export default function Settings() {
  const { config, isLoading, saveConfig, isSaving } = useConfig();
  const { data: stats } = useDaemon();
  const { restart } = useRestart();

  // Initialise form from config on first load. A ref tracks whether we have
  // initialised so we only seed once — subsequent config refetches do NOT
  // overwrite user edits. This replaces the previous useEffect + null-check
  // pattern which is a React anti-pattern for derived initial state.
  const formInitialised = useRef(false);
  const [form, setForm] = useState<FormState | null>(null);
  if (config && !formInitialised.current) {
    formInitialised.current = true;
    // Safe to call during render: React batches the setState and re-renders
    // once. This avoids the "unnecessary Effect for initialising state" pattern.
    if (form === null) {
      setForm(toFormState(config));
    }
  }

  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState<string>('');

  const dirty = form && config ? isDirty(form, config) : false;

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
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
  }, [form, config, saveConfig, restart]);

  const handleTestConnection = useCallback(async () => {
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
  }, [form]);

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
    <div className="p-6">
      <PageHeader title="Settings" subtitle="Vault configuration and daemon settings" />

      <div className="space-y-6">
        {/* ---- Top row: Project + Embedding side by side ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- Project section ---- */}
        <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
          <SectionHeader>Project</SectionHeader>

          <div className="space-y-4">
            {/* Vault name -- read-only */}
            <div className="space-y-1.5">
              <FieldLabel>Vault Name</FieldLabel>
              <Input value={vaultName} readOnly disabled className="text-on-surface-variant bg-surface-container-lowest" />
            </div>

            {/* Daemon port */}
            <div className="space-y-1.5">
              <FieldLabel>Daemon Port</FieldLabel>
              <Input
                type="number"
                placeholder="Auto"
                value={form.daemonPort}
                onChange={e => setField('daemonPort', e.target.value)}
              />
              <FieldHint>Leave blank to use a random available port.</FieldHint>
            </div>

            {/* Log level */}
            <div className="space-y-1.5">
              <FieldLabel>Log Level</FieldLabel>
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
          </div>
        </Surface>

        {/* ---- Embedding section ---- */}
        <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-ochre h-fit">
          <SectionHeader>Embedding</SectionHeader>

          <div className="space-y-4">
            {/* Provider */}
            <div className="space-y-1.5">
              <FieldLabel>Provider</FieldLabel>
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
            <div className="space-y-1.5">
              <FieldLabel>Model</FieldLabel>
              <Input
                placeholder="bge-m3"
                value={form.embeddingModel}
                onChange={e => setField('embeddingModel', e.target.value)}
              />
            </div>

            {/* Base URL */}
            <div className="space-y-1.5">
              <FieldLabel hint="optional">Base URL</FieldLabel>
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
          </div>
        </Surface>
        </div>{/* end top row grid */}

        {/* ---- Agent section ---- */}
        <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-outline">
          <SectionHeader>Agent</SectionHeader>

          <div className="space-y-4">
            {/* Auto-run toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FieldLabel>Auto Run</FieldLabel>
                <FieldHint>Automatically run the agent on unprocessed batches.</FieldHint>
              </div>
              <Switch checked={form.agentAutoRun} onCheckedChange={v => setField('agentAutoRun', v)} />
            </div>

            {/* Interval */}
            <div className="space-y-1.5">
              <FieldLabel>Run Interval (seconds)</FieldLabel>
              <Input
                type="number"
                min="30"
                placeholder="300"
                value={form.agentIntervalSeconds}
                onChange={e => setField('agentIntervalSeconds', e.target.value)}
              />
              <FieldHint>Seconds between agent timer checks. Minimum 30.</FieldHint>
            </div>

            {/* Summary batch interval */}
            <div className="space-y-1.5">
              <FieldLabel>Summary Batch Interval</FieldLabel>
              <Input
                type="number"
                min="0"
                placeholder="5"
                value={form.agentSummaryBatchInterval}
                onChange={e => setField('agentSummaryBatchInterval', e.target.value)}
              />
              <FieldHint>Trigger a session summary every N batches. Set to 0 to disable.</FieldHint>
            </div>
          </div>
        </Surface>

        {/* ---- Context Injection section ---- */}
        <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-ochre">
          <SectionHeader>Context Injection</SectionHeader>

          <div className="space-y-4">
            {/* Digest tier */}
            <div className="space-y-1.5">
              <FieldLabel>Digest Tier</FieldLabel>
              <Select
                value={form.contextDigestTier}
                onValueChange={v => setField('contextDigestTier', v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIGEST_TIERS.map(tier => (
                    <SelectItem key={tier.value} value={tier.value}>
                      {tier.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>Token budget for digest context injected at session start.</FieldHint>
            </div>

            {/* Prompt search toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <FieldLabel>Prompt Search</FieldLabel>
                <FieldHint>Search vault for relevant observations on each prompt.</FieldHint>
              </div>
              <Switch checked={form.contextPromptSearch} onCheckedChange={v => setField('contextPromptSearch', v)} />
            </div>

            {/* Max spores per prompt */}
            <div className="space-y-1.5">
              <FieldLabel>Max Spores per Prompt</FieldLabel>
              <Input
                type="number"
                min="0"
                max="10"
                placeholder="3"
                value={form.contextMaxSpores}
                onChange={e => setField('contextMaxSpores', e.target.value)}
              />
              <FieldHint>Maximum observations injected per prompt. Lower = leaner context.</FieldHint>
            </div>
          </div>
        </Surface>

        {/* ---- Save row ---- */}
        <Surface level="low" className="p-4 flex items-center gap-4 border-t-2 border-t-sage">
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
        </Surface>
      </div>
    </div>
  );
}
