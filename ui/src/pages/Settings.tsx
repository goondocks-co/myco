import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConfig, type MycoConfig } from '../hooks/use-config';
import { useDaemon } from '../hooks/use-daemon';
import { useRestart } from '../hooks/use-restart';
import { useProviders, useTestProvider } from '../hooks/use-providers';
import { useModels } from '../hooks/use-models';
import { fetchJson } from '../lib/api';
import { parseNumericField } from '../lib/format';
import { DEFAULT_DIGEST_TIER, DEFAULT_MAX_SPORES } from '../lib/constants';
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
import { PlanCaptureCard } from '../components/config/PlanCaptureCard';
import { NotificationSettings } from '../components/notifications/NotificationSettings';
import { ProviderModelSelector } from '../components/providers/ProviderModelSelector';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Provider = 'ollama' | 'openai-compatible';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

type AgentProviderType = 'anthropic' | 'ollama' | 'lmstudio';

const DIGEST_TIERS: { value: string; label: string }[] = [
  { value: '1500', label: '1.5K — Executive briefing' },
  { value: '5000', label: '5K — Deep onboarding' },
  { value: '10000', label: '10K — Full institutional' },
];

type TestState = 'idle' | 'testing' | 'success' | 'error';

interface FormState {
  daemonPort: string;
  logLevel: LogLevel;
  logRetentionDays: string;
  embeddingProvider: Provider;
  embeddingModel: string;
  embeddingBaseUrl: string;
  contextDigestTier: string;
  contextPromptSearch: boolean;
  contextMaxSpores: string;
  agentProviderType: AgentProviderType | '';
  agentModel: string;
  agentBaseUrl: string;
  agentContextLength: string;
}

function toFormState(config: MycoConfig): FormState {
  return {
    daemonPort: config.daemon.port != null ? String(config.daemon.port) : '',
    logLevel: config.daemon.log_level,
    logRetentionDays: String(config.daemon.log_retention_days),
    embeddingProvider: config.embedding.provider,
    embeddingModel: config.embedding.model,
    embeddingBaseUrl: config.embedding.base_url ?? '',
    contextDigestTier: String(config.context?.digest_tier ?? DEFAULT_DIGEST_TIER),
    contextPromptSearch: config.context?.prompt_search ?? true,
    contextMaxSpores: String(config.context?.prompt_max_spores ?? DEFAULT_MAX_SPORES),
    agentProviderType: (config.agent?.provider?.type as AgentProviderType) ?? '',
    agentModel: config.agent?.provider?.model ?? config.agent?.model ?? '',
    agentBaseUrl: config.agent?.provider?.base_url ?? '',
    agentContextLength: config.agent?.provider?.context_length?.toString() ?? '',
  };
}

/* ---------- Per-section config builders ---------- */
//
// Each section's save button writes only its own slice of the config.
// All builders preserve unrelated sections via `...original` spread.
// This lets users save sections independently without committing
// half-finished edits in other sections.

function buildAgentConfigUpdate(form: FormState, original: MycoConfig): MycoConfig {
  const hadProvider = !!original.agent?.provider;
  const hasProvider = form.agentProviderType !== '';

  const agentProvider = hasProvider
    ? {
        type: form.agentProviderType as AgentProviderType,
        ...(form.agentModel ? { model: form.agentModel } : {}),
        ...(form.agentBaseUrl ? { base_url: form.agentBaseUrl } : {}),
        ...(form.agentContextLength ? { context_length: Number(form.agentContextLength) } : {}),
      }
    : undefined;

  // Auto-enable on first provider config; auto-disable when cleared.
  let scheduledEnabled = original.agent?.scheduled_tasks_enabled;
  let eventEnabled = original.agent?.event_tasks_enabled;
  if (hasProvider && !hadProvider) {
    scheduledEnabled = true;
    eventEnabled = true;
  } else if (!hasProvider && hadProvider) {
    scheduledEnabled = false;
    eventEnabled = false;
  }

  return {
    ...original,
    agent: {
      ...original.agent,
      provider: agentProvider,
      model: undefined,
      scheduled_tasks_enabled: scheduledEnabled,
      event_tasks_enabled: eventEnabled,
    },
  };
}

function buildEmbeddingConfigUpdate(form: FormState, original: MycoConfig): MycoConfig {
  return {
    ...original,
    embedding: {
      ...original.embedding,
      provider: form.embeddingProvider,
      model: form.embeddingModel,
      base_url: form.embeddingBaseUrl !== '' ? form.embeddingBaseUrl : undefined,
    },
  };
}

function buildContextConfigUpdate(form: FormState, original: MycoConfig): MycoConfig {
  return {
    ...original,
    context: {
      ...original.context,
      digest_tier: parseNumericField(form.contextDigestTier, DEFAULT_DIGEST_TIER),
      prompt_search: form.contextPromptSearch,
      prompt_max_spores: parseNumericField(form.contextMaxSpores, DEFAULT_MAX_SPORES),
    },
  };
}

function buildProjectConfigUpdate(form: FormState, original: MycoConfig): MycoConfig {
  return {
    ...original,
    daemon: {
      ...original.daemon,
      port: form.daemonPort !== '' ? Number(form.daemonPort) : null,
      log_level: form.logLevel,
      log_retention_days: Number(form.logRetentionDays),
    },
  };
}

/* ---------- Per-section field map (drives dirty checks) ---------- */

type SaveSection = 'agent' | 'embedding' | 'context' | 'project';

const SECTION_FIELDS: Record<SaveSection, (keyof FormState)[]> = {
  agent: ['agentProviderType', 'agentModel', 'agentBaseUrl', 'agentContextLength'],
  embedding: ['embeddingProvider', 'embeddingModel', 'embeddingBaseUrl'],
  context: ['contextDigestTier', 'contextPromptSearch', 'contextMaxSpores'],
  project: ['daemonPort', 'logLevel', 'logRetentionDays'],
};

function isSectionDirty(section: SaveSection, form: FormState, orig: FormState): boolean {
  return SECTION_FIELDS[section].some((k) => form[k] !== orig[k]);
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

/** Per-section Save button + status message footer. Rendered at the bottom of each Surface card. */
function SectionSaveRow({
  dirty,
  isSaving,
  showMessage,
  message,
  onSave,
}: {
  dirty: boolean;
  isSaving: boolean;
  showMessage: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-3 pt-2 border-t border-outline-variant/20">
      <Button onClick={onSave} disabled={!dirty || isSaving} size="sm">
        {isSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
        Save
      </Button>
      {showMessage && message && (
        <span
          className={
            message.type === 'success'
              ? 'font-sans text-xs text-primary'
              : 'font-sans text-xs text-tertiary'
          }
        >
          {message.text}
        </span>
      )}
    </div>
  );
}

/* ---------- Page ---------- */

export default function Settings() {
  const { config, isLoading, saveConfig, isSaving } = useConfig();
  const { data: stats } = useDaemon();
  const { restart } = useRestart();
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const agentTestMutation = useTestProvider();

  // Initialise form from config on first load. A ref tracks whether we have
  // initialised so we only seed once — subsequent config refetches do NOT
  // overwrite user edits. This replaces the previous useEffect + null-check
  // pattern which is a React anti-pattern for derived initial state.
  const formInitialised = useRef(false);
  const [form, setForm] = useState<FormState | null>(null);
  if (config && !formInitialised.current) {
    formInitialised.current = true;
    if (form === null) {
      setForm(toFormState(config));
    }
  }

  const [saveMessage, setSaveMessage] = useState<{ section: SaveSection; type: 'success' | 'error'; text: string } | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState<string>('');

  // Fetch embedding models for the currently selected provider/baseUrl.
  const { data: embeddingModelsData } = useModels(
    form?.embeddingProvider ?? null,
    form?.embeddingBaseUrl || undefined,
    'embedding',
  );
  const embeddingModels = embeddingModelsData?.models ?? [];

  // Backfill the agent model when an older config has provider.type but no
  // model — fall back to the provider's first available model so the dropdown
  // never shows a blank Save state. Only fires when the model field is empty.
  useEffect(() => {
    if (!form || form.agentProviderType === '' || form.agentModel !== '') return;
    const firstModel = providersData?.providers.find(p => p.type === form.agentProviderType)?.models?.[0];
    if (firstModel) {
      setForm(prev => prev ? { ...prev, agentModel: firstModel } : prev);
    }
  }, [form, providersData]);

  // origForm is memoized on config so per-keystroke re-renders don't reallocate it.
  const origForm = useMemo(() => (config ? toFormState(config) : null), [config]);
  const agentDirty = !!(form && origForm && isSectionDirty('agent', form, origForm));
  const embeddingDirty = !!(form && origForm && isSectionDirty('embedding', form, origForm));
  const contextDirty = !!(form && origForm && isSectionDirty('context', form, origForm));
  const projectDirty = !!(form && origForm && isSectionDirty('project', form, origForm));

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaveMessage(null);
  }, []);

  /** Per-section save: looks up the section's config builder, saves, restarts the daemon. */
  const SECTION_BUILDERS: Record<SaveSection, (f: FormState, c: MycoConfig) => MycoConfig> = {
    agent: buildAgentConfigUpdate,
    embedding: buildEmbeddingConfigUpdate,
    context: buildContextConfigUpdate,
    project: buildProjectConfigUpdate,
  };

  const handleSectionSave = useCallback(async (section: SaveSection) => {
    if (!form || !config) return;
    setSaveMessage(null);
    try {
      await saveConfig(SECTION_BUILDERS[section](form, config));
      setSaveMessage({ section, type: 'success', text: 'Saved. Restarting daemon...' });
      try {
        await restart();
      } catch {
        // Restart may fail if daemon is already restarting; the save still succeeded
        setSaveMessage({ section, type: 'success', text: 'Saved. Daemon restart may require manual action.' });
      }
    } catch {
      setSaveMessage({ section, type: 'error', text: 'Failed to save.' });
    }
  // SECTION_BUILDERS is module-stable; safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleTestAgentProvider = useCallback(() => {
    if (!form || !form.agentProviderType) return;
    agentTestMutation.mutate({
      type: form.agentProviderType,
      ...(form.agentBaseUrl ? { base_url: form.agentBaseUrl } : {}),
    });
  }, [form, agentTestMutation]);

  if (isLoading || !form || !config) {
    return (
      <div className="p-6">
        <PageHeader title="Settings" />
        <p className="font-sans text-sm text-on-surface-variant mt-2">Loading...</p>
      </div>
    );
  }

  const vaultName = stats?.vault.name ?? config.embedding.provider;

  const providers = providersData?.providers ?? [];

  return (
    <div className="p-6">
      <PageHeader title="Settings" subtitle="Vault configuration and daemon settings" />

      <div className="space-y-6">
        {/* ---- Top row: Myco Agent + Embedding side by side ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- Myco Agent section ---- */}
        <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
          <SectionHeader>Myco Agent</SectionHeader>

          {form.agentProviderType === '' ? (
            <p className="font-sans text-sm text-on-surface-variant">
              No provider configured -- data collection is active. Configure a provider
              to enable the intelligence pipeline.
            </p>
          ) : null}

          <ProviderModelSelector
            providerType={form.agentProviderType}
            model={form.agentModel}
            baseUrl={form.agentBaseUrl}
            contextLength={form.agentContextLength}
            providers={providers}
            isLoadingProviders={isLoadingProviders}
            onProviderChange={(type) => {
              setField('agentProviderType', type as AgentProviderType);
              const providerInfo = providers.find(p => p.type === type);
              // First available model defaults the dropdown so it never saves with an unset model
              setField('agentModel', providerInfo?.models?.[0] ?? '');
              setField('agentBaseUrl', providerInfo?.baseUrl ?? '');
              setField('agentContextLength', '');
              agentTestMutation.reset();
            }}
            onModelChange={(m) => setField('agentModel', m)}
            onBaseUrlChange={(url) => {
              setField('agentBaseUrl', url);
              agentTestMutation.reset();
            }}
            onContextLengthChange={(ctx) => setField('agentContextLength', ctx)}
          />

          {form.agentProviderType !== '' && (
            <>
              <div className="flex items-center gap-3 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleTestAgentProvider}
                  disabled={agentTestMutation.isPending}
                >
                  {agentTestMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Test Connection
                </Button>
                {agentTestMutation.isSuccess && agentTestMutation.data.ok && (
                  <span className="flex items-center gap-1 font-sans text-sm text-primary">
                    <CheckCircle className="h-4 w-4" />
                    Connected — {agentTestMutation.data.latency_ms}ms
                  </span>
                )}
                {agentTestMutation.isSuccess && !agentTestMutation.data.ok && (
                  <span className="flex items-center gap-1 font-sans text-sm text-tertiary">
                    <XCircle className="h-4 w-4" />
                    {agentTestMutation.data.error ?? 'Connection failed.'}
                  </span>
                )}
                {agentTestMutation.isError && (
                  <span className="flex items-center gap-1 font-sans text-sm text-tertiary">
                    <XCircle className="h-4 w-4" />
                    {agentTestMutation.error.message}
                  </span>
                )}
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setField('agentProviderType', '');
                  setField('agentModel', '');
                  setField('agentBaseUrl', '');
                  setField('agentContextLength', '');
                  agentTestMutation.reset();
                }}
                className="text-xs text-on-surface-variant"
              >
                Clear provider
              </Button>
            </>
          )}

          <SectionSaveRow
            dirty={agentDirty}
            isSaving={isSaving}
            showMessage={saveMessage?.section === 'agent'}
            message={saveMessage}
            onSave={() => handleSectionSave('agent')}
          />
        </Surface>

        {/* ---- Embedding section ---- */}
        <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-ochre">
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

            {/* Model — dropdown when models are available, falls back to text input */}
            <div className="space-y-1.5">
              <FieldLabel>Model</FieldLabel>
              {embeddingModels.length > 0 ? (
                <Select
                  value={form.embeddingModel}
                  onValueChange={v => setField('embeddingModel', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {embeddingModels.map(m => (
                      <SelectItem key={m} value={m}>
                        <span className="font-mono text-sm">{m}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  placeholder="bge-m3"
                  value={form.embeddingModel}
                  onChange={e => setField('embeddingModel', e.target.value)}
                />
              )}
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

          <SectionSaveRow
            dirty={embeddingDirty}
            isSaving={isSaving}
            showMessage={saveMessage?.section === 'embedding'}
            message={saveMessage}
            onSave={() => handleSectionSave('embedding')}
          />
        </Surface>
        </div>{/* end top row grid */}

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

          <SectionSaveRow
            dirty={contextDirty}
            isSaving={isSaving}
            showMessage={saveMessage?.section === 'context'}
            message={saveMessage}
            onSave={() => handleSectionSave('context')}
          />
        </Surface>

        {/* ---- Notifications section ---- */}
        <NotificationSettings />

        {/* ---- Plan Capture section ---- */}
        <PlanCaptureCard />

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

            {/* Log retention */}
            <div className="space-y-1.5">
              <FieldLabel>Log Retention (days)</FieldLabel>
              <Input
                type="number"
                min={1}
                max={365}
                className="w-24"
                value={form.logRetentionDays}
                onChange={e => setField('logRetentionDays', e.target.value)}
              />
            </div>
          </div>

          <SectionSaveRow
            dirty={projectDirty}
            isSaving={isSaving}
            showMessage={saveMessage?.section === 'project'}
            message={saveMessage}
            onSave={() => handleSectionSave('project')}
          />
        </Surface>
      </div>
    </div>
  );
}
