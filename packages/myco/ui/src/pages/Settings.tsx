import { useState, useCallback, useEffect } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useDaemon } from '../hooks/use-daemon';
import {
  CONFIG_SECTION_IDS,
  configFieldId,
} from '@myco/config/focus';
import {
  useProviders,
  useTestProvider,
  maybeInferRuntimeFromProviderType,
  resolveReasoningModel,
} from '../hooks/use-providers';
import type { ProviderDraft } from '../hooks/use-providers';
import {
  draftToNormalizedProviderConfig,
  useProviderConfigDraft,
} from '../hooks/use-provider-config-draft';
import {
  useDeleteProviderSecret,
  useProviderSecrets,
  useSaveProviderSecret,
  type SecretProvider,
} from '../hooks/use-provider-secrets';
import { useModels } from '../hooks/use-models';
import { fetchJson } from '../lib/api';
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
import { SearchableSelect } from '../components/ui/searchable-select';
import { Switch } from '../components/ui/switch';
import { PlanCaptureCard } from '../components/config/PlanCaptureCard';
import { ScopedField } from '../components/config/ScopedField';
import { ScopeBadge, ScopePill } from '../components/config/ScopePill';
import { RestartGateProvider, RestartBanner } from '../components/config/restart-gate';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { NotificationSettings } from '../components/notifications/NotificationSettings';
import { ProviderModelSelector } from '../components/providers/ProviderModelSelector';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Provider = 'ollama' | 'openai-compatible';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

const DIGEST_TIERS: { value: string; label: string }[] = [
  { value: '1500', label: '1.5K — Executive briefing' },
  { value: '5000', label: '5K — Deep onboarding' },
  { value: '10000', label: '10K — Full institutional' },
];

type TestState = 'idle' | 'testing' | 'success' | 'error';

/* ---------- Page ---------- */

export default function Settings() {
  const { effective, isLoading } = useScopedConfig();
  const { data: stats } = useDaemon();

  if (isLoading || !effective) {
    return (
      <div className="p-6">
        <PageHeader title="Settings" />
        <p className="font-sans text-sm text-on-surface-variant mt-2">Loading...</p>
      </div>
    );
  }

  const vaultName = stats?.vault.name ?? effective.embedding.provider;

  return (
    <RestartGateProvider>
    <div className="p-6">
      <PageHeader title="Settings" subtitle="Vault configuration and daemon settings" />
      <RestartBanner />

      <div className="space-y-6">
        {/* ---- Top row: Myco Agent + Embedding side by side ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- Myco Agent section ---- */}
        <AgentProviderCard />

        {/* ---- Embedding section ---- */}
        <EmbeddingCard />
        </div>{/* end top row grid */}

        {/* ---- Context Injection section ---- */}
        <ContextInjectionCard />

        {/* ---- Notifications section ---- */}
        <NotificationSettings />

        {/* ---- Plan Capture section ---- */}
        <PlanCaptureCard />

        {/* ---- Project section (scoped-field POC) ---- */}
        <ProjectCard vaultName={vaultName} />
      </div>
    </div>
    </RestartGateProvider>
  );
}

const REMOTE_SECRET_LABELS: Record<SecretProvider, string> = {
  openai: 'OpenAI API Key',
  openrouter: 'OpenRouter API Key',
};

function isSecretProvider(type: ProviderDraft['type']): type is SecretProvider {
  return type === 'openai' || type === 'openrouter';
}

/** Myco Agent — personal-default. Provider configuration is staged locally
 *  and saved explicitly because runtime -> provider -> model -> reasoning is
 *  a dependency chain that cannot be persisted safely as independent writes.
 *  Two coupled writes use setFields:
 *    • setting a provider for the first time also enables both task toggles
 *    • clearing the provider disables both task toggles and removes overrides */
function AgentProviderCard() {
  const { effective, setFields, isLocalOverride, resetField, promoteField } = useScopedConfig();
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const { data: providerSecretsData } = useProviderSecrets();
  const saveProviderSecret = useSaveProviderSecret();
  const deleteProviderSecret = useDeleteProviderSecret();
  const agentTestMutation = useTestProvider();

  const providers = providersData?.providers ?? [];
  const provider = effective?.agent?.provider;
  const agentRuntime = effective?.agent?.runtime;
  const {
    draft,
    savedDraft,
    isDirty,
    clearDraft,
    resetDraft,
    handleRuntimeChange,
    handleProviderChange,
    handleModelChange,
    handleReasoningChange,
    handleBaseUrlChange,
    handleContextLengthChange,
  } = useProviderConfigDraft({
    source: {
      runtime: agentRuntime,
      provider,
    },
    providers,
  });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const secretProvider = isSecretProvider(draft.type) ? draft.type : null;
  const activeSecret = secretProvider ? providerSecretsData?.secrets[secretProvider] : undefined;
  const modelsQuery = useModels(draft.type || null, draft.baseUrl || undefined, 'llm');
  const reasoningModels = modelsQuery.data?.models ?? providers.find((info) => info.type === draft.type)?.models ?? [];
  const supportsReasoningMap = draft.type !== '';
  useEffect(() => { setApiKeyInput(''); }, [draft.type]);

  const personal = isLocalOverride('agent.provider') || isLocalOverride('agent.runtime');
  const handleResetScope = useCallback(async () => {
    if (isLocalOverride('agent.runtime')) {
      await resetField('agent.runtime');
    }
    if (isLocalOverride('agent.provider')) {
      await resetField('agent.provider');
    }
  }, [isLocalOverride, resetField]);
  const handlePromoteScope = useCallback(async () => {
    if (isLocalOverride('agent.runtime')) {
      await promoteField('agent.runtime');
    }
    if (isLocalOverride('agent.provider')) {
      await promoteField('agent.provider');
    }
  }, [isLocalOverride, promoteField]);

  const writeProvider = useCallback((next: ProviderDraft, autoEnableTasks: boolean) => {
    const value = draftToNormalizedProviderConfig(next, reasoningModels);
    const fields: Array<{ path: 'agent.runtime' | 'agent.provider' | 'agent.scheduled_tasks_enabled' | 'agent.event_tasks_enabled'; value: unknown }> = [
      { path: 'agent.runtime', value: next.runtime || maybeInferRuntimeFromProviderType(next.type) },
      { path: 'agent.provider', value },
    ];
    if (autoEnableTasks) {
      fields.push(
        { path: 'agent.scheduled_tasks_enabled', value: true },
        { path: 'agent.event_tasks_enabled', value: true },
      );
    }
    void setFields(fields, 'local');
  }, [reasoningModels, setFields]);

  const handleClear = useCallback(() => {
    clearDraft();
    agentTestMutation.reset();
  }, [agentTestMutation, clearDraft]);

  const handleResetDraft = useCallback(() => {
    resetDraft();
    agentTestMutation.reset();
  }, [agentTestMutation, resetDraft]);

  const handleSaveProvider = useCallback(async () => {
    const isClearingProvider = draft.type === '';
    if (isClearingProvider) {
      try {
        await setFields(
          [
            { path: 'agent.scheduled_tasks_enabled', value: false },
            { path: 'agent.event_tasks_enabled', value: false },
          ],
          'local',
          ['agent.provider', 'agent.runtime'],
        );
      } catch (err) {
        console.error('[agent-card] clear provider failed', err);
      }
      return;
    }

    const shouldAutoEnableTasks = savedDraft.type === '' && draft.type !== '';
    writeProvider(draft, shouldAutoEnableTasks);
  }, [draft, savedDraft.type, setFields, writeProvider]);

  const handleSaveApiKey = useCallback(() => {
    if (!secretProvider || apiKeyInput.trim() === '') return;
    saveProviderSecret.mutate({ provider: secretProvider, apiKey: apiKeyInput.trim() }, {
      onSuccess: () => {
        setApiKeyInput('');
        agentTestMutation.reset();
      },
    });
  }, [agentTestMutation, apiKeyInput, saveProviderSecret, secretProvider]);

  const handleClearApiKey = useCallback(() => {
    if (!secretProvider) return;
    deleteProviderSecret.mutate(secretProvider, {
      onSuccess: () => {
        setApiKeyInput('');
        agentTestMutation.reset();
      },
    });
  }, [agentTestMutation, deleteProviderSecret, secretProvider]);

  const handleTestConnection = useCallback(() => {
    if (draft.type === '') return;
    agentTestMutation.mutate({
      type: draft.type,
      runtime: draft.runtime || undefined,
      ...(draft.baseUrl ? { base_url: draft.baseUrl } : {}),
    });
  }, [draft.baseUrl, draft.runtime, draft.type, agentTestMutation]);

  return (
    <Surface
      id={CONFIG_SECTION_IDS.settingsAgent}
      data-config-field="agent.provider"
      level="low"
      className="rounded-lg p-6 space-y-5 border-t-2 border-t-sage transition-all duration-300"
    >
      <SectionHeader>
        <span className="flex items-center gap-2">
          Myco Agent
          {personal ? (
            <ScopePill onPromote={handlePromoteScope} onReset={handleResetScope} />
          ) : (
            <ScopeBadge scope="project" />
          )}
        </span>
      </SectionHeader>

      {draft.type === '' ? (
        <p className="font-sans text-sm text-on-surface-variant">
          No provider configured -- data collection is active. Configure a provider
          to enable the intelligence pipeline.
        </p>
      ) : null}

      <ProviderModelSelector
        runtime={draft.runtime}
        providerType={draft.type}
        model={draft.model}
        baseUrl={draft.baseUrl}
        contextLength={draft.contextLength}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
        onRuntimeChange={(runtime) => {
          handleRuntimeChange(runtime);
          agentTestMutation.reset();
        }}
        onProviderChange={(type) => {
          handleProviderChange(type);
          agentTestMutation.reset();
        }}
        onModelChange={handleModelChange}
        onBaseUrlChange={handleBaseUrlChange}
        onContextLengthChange={handleContextLengthChange}
      />

      {supportsReasoningMap && (
        <div className="space-y-3 rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest p-3">
          <div>
            <p className="font-sans text-xs text-on-surface-variant uppercase tracking-wide">Reasoning Profiles</p>
            <p className="font-sans text-xs text-on-surface-variant/80 mt-1">
              Built-in tasks resolve `low`, `default`, and `high` reasoning phases through these model mappings.
            </p>
          </div>
          {([
            ['low', 'Reasoning Low'],
            ['default', 'Reasoning Default'],
            ['high', 'Reasoning High'],
          ] as const).map(([level, label]) => {
            const value = level === 'low'
              ? draft.reasoningLow
              : level === 'default'
                ? draft.reasoningDefault
                : draft.reasoningHigh;
            const setValue = (next: string) => handleReasoningChange(level, next);
            const placeholder = resolveReasoningModel(level, {
              model: draft.model || undefined,
              reasoning_map: {
                ...(draft.reasoningLow ? { low: draft.reasoningLow } : {}),
                ...(draft.reasoningDefault ? { default: draft.reasoningDefault } : {}),
                ...(draft.reasoningHigh ? { high: draft.reasoningHigh } : {}),
              },
            }, draft.model);
            return (
              <div key={level} className="space-y-1">
                <label className="font-sans text-xs text-on-surface-variant">{label}</label>
                {reasoningModels.length > 0 ? (
                  <SearchableSelect
                    value={value}
                    onValueChange={setValue}
                    placeholder={placeholder || 'Use default model'}
                    searchPlaceholder="Search models..."
                    emptyMessage="No models match that search."
                    options={reasoningModels.map((candidate) => ({
                      value: candidate,
                      label: candidate,
                    }))}
                    sortOptions
                    monospace
                  />
                ) : (
                  <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={placeholder || 'Use default model'}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {secretProvider && (
        <div className="space-y-2 rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest p-3">
          <div className="space-y-1">
            <label className="font-sans text-xs text-on-surface-variant">{REMOTE_SECRET_LABELS[secretProvider]}</label>
            <Input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={activeSecret?.configured ? 'Replace saved key' : 'Paste API key'}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleSaveApiKey}
              disabled={saveProviderSecret.isPending || apiKeyInput.trim() === ''}
            >
              Save key
            </Button>
            {activeSecret?.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClearApiKey}
                disabled={deleteProviderSecret.isPending}
              >
                Clear key
              </Button>
            )}
            <span className="font-sans text-xs text-on-surface-variant break-all">
              {activeSecret?.configured
                ? `${activeSecret.maskedValue} stored ${activeSecret.source === 'vault' ? 'in vault secrets' : 'from environment'}`
                : 'Key is required for model discovery and connection tests.'}
            </span>
          </div>
        </div>
      )}

      {(draft.type !== '' || isDirty) && (
        <>
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleSaveProvider}
              disabled={!isDirty}
            >
              Save Changes
            </Button>
            {isDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResetDraft}
              >
                Reset
              </Button>
            ) : null}
            {draft.type !== '' ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={agentTestMutation.isPending}
                >
                  {agentTestMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
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
              </>
            ) : null}
          </div>

          {draft.type !== '' || savedDraft.type !== '' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="text-xs text-on-surface-variant"
            >
              Clear provider
            </Button>
          ) : null}
        </>
      )}
    </Surface>
  );
}

/** Embedding — provider endpoint + model selection. Personal-default by
 *  design: each machine has its own Ollama/OpenAI-compatible endpoint and
 *  may prefer different models based on local hardware. */
function EmbeddingCard() {
  const { effective } = useScopedConfig();
  const currentProvider = effective?.embedding.provider ?? 'ollama';
  const currentBaseUrl = effective?.embedding.base_url ?? '';
  const { data: embeddingModelsData } = useModels(currentProvider, currentBaseUrl || undefined, 'embedding');
  const embeddingModels = embeddingModelsData?.models ?? [];
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  const handleTestConnection = useCallback(async () => {
    setTestState('testing');
    setTestMessage('');
    try {
      const params = new URLSearchParams({ provider: currentProvider, type: 'embedding' });
      if (currentBaseUrl) params.set('base_url', currentBaseUrl);
      const result = await fetchJson<{ provider: string; models: string[] }>(`/models?${params.toString()}`);
      const count = result.models.length;
      setTestState('success');
      setTestMessage(`Connected -- ${count} model${count !== 1 ? 's' : ''} available.`);
    } catch (err) {
      setTestState('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  }, [currentProvider, currentBaseUrl]);

  return (
    <Surface
      id={CONFIG_SECTION_IDS.settingsEmbedding}
      level="low"
      className="rounded-lg p-6 space-y-5 border-t-2 border-t-ochre transition-all duration-300"
    >
      <SectionHeader>Embedding</SectionHeader>

      <div className="space-y-4">
        <ScopedField
          path="embedding.provider"
          label="Provider"
          defaultScope="local"
          requiresRestart
        >
          {({ value, onChange }) => (
            <Select value={value ?? 'ollama'} onValueChange={(v) => { onChange(v as Provider); setTestState('idle'); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ScopedField>

        <ScopedField
          path="embedding.model"
          label="Model"
          defaultScope="local"
          requiresRestart
          commitOn={embeddingModels.length > 0 ? 'change' : 'blur'}
        >
          {({ value, onChange, onBlur }) =>
            embeddingModels.length > 0 ? (
              <SearchableSelect
                value={value ?? ''}
                onValueChange={onChange}
                placeholder="Select a model"
                searchPlaceholder="Search embedding models..."
                emptyMessage="No embedding models match that search."
                options={embeddingModels.map((candidate) => ({
                  value: candidate,
                  label: candidate,
                }))}
                sortOptions
                monospace
              />
            ) : (
              <Input
                placeholder="bge-m3"
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
              />
            )
          }
        </ScopedField>

        <ScopedField
          path="embedding.base_url"
          label="Base URL"
          hint="optional"
          defaultScope="local"
          requiresRestart
          commitOn="blur"
          parse={(v) => (v === '' ? (undefined as unknown as string) : v)}
        >
          {({ value, onChange, onBlur }) => (
            <Input
              type="url"
              placeholder="http://localhost:11434"
              value={value ?? ''}
              onChange={(e) => { onChange(e.target.value); setTestState('idle'); }}
              onBlur={onBlur}
            />
          )}
        </ScopedField>

        <div className="flex items-center gap-3 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={handleTestConnection} disabled={testState === 'testing'}>
            {testState === 'testing' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
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
  );
}

/** Context Injection — project-default fields shape the intelligence
 *  pipeline's input budget, so they should be consistent across the team
 *  by default. Still overridable per-machine via the Personal pill. */
function ContextInjectionCard() {
  return (
    <Surface
      id={CONFIG_SECTION_IDS.settingsContextInjection}
      level="low"
      className="rounded-lg p-6 space-y-5 border-t-2 border-t-ochre transition-all duration-300"
    >
      <SectionHeader>Context Injection</SectionHeader>

      <div className="space-y-4">
        <ScopedField
          path="context.digest_tier"
          label="Digest Tier"
          defaultScope="project"
          hint="token budget for session-start digest"
        >
          {({ value, onChange }) => (
            <Select value={String(value ?? DEFAULT_DIGEST_TIER)} onValueChange={(v) => onChange(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIGEST_TIERS.map((tier) => (
                  <SelectItem key={tier.value} value={tier.value}>
                    {tier.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ScopedField>

        <ScopedField
          path="context.prompt_search"
          label="Prompt Search"
          defaultScope="project"
          hint="search vault for observations on each prompt"
        >
          {({ value, onChange }) => (
            <Switch checked={value ?? true} onCheckedChange={onChange} />
          )}
        </ScopedField>

        <ScopedField
          path="context.prompt_max_spores"
          label="Max Spores per Prompt"
          defaultScope="project"
          commitOn="blur"
          hint="0–10; lower = leaner context"
        >
          {({ value, onChange, onBlur }) => (
            <Input
              type="number"
              min="0"
              max="10"
              placeholder={String(DEFAULT_MAX_SPORES)}
              value={value ?? ''}
              onChange={(e) => onChange(Number(e.target.value))}
              onBlur={onBlur}
            />
          )}
        </ScopedField>
      </div>
    </Surface>
  );
}

/** Project card rebuilt on the scoped-field pattern — writes immediately to
 *  the chosen scope, surfaces a page-level "Restart required" banner, and
 *  lets any field be promoted/reset between personal and project scope. */
function ProjectCard({ vaultName }: { vaultName: string }) {
  return (
    <Surface
      id={CONFIG_SECTION_IDS.settingsProject}
      level="low"
      className="rounded-lg p-6 space-y-5 border-t-2 border-t-sage transition-all duration-300"
    >
      <SectionHeader>Project</SectionHeader>

      <div className="space-y-4">
        {/* Vault name -- read-only */}
        <div
          id={configFieldId('vault.name')}
          data-config-field="vault.name"
          className="space-y-1.5 rounded-md transition-all duration-300"
        >
          <label className="font-sans text-sm font-medium text-on-surface">Vault Name</label>
          <Input value={vaultName} readOnly disabled className="text-on-surface-variant bg-surface-container-lowest" />
        </div>

        <ScopedField
          path="daemon.port"
          label="Daemon Port"
          defaultScope="local"
          requiresRestart
          commitOn="blur"
        >
          {({ value, onChange, onBlur }) => (
            <>
              <Input
                type="number"
                placeholder="Auto"
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
                onBlur={onBlur}
              />
              <p className="font-sans text-xs text-on-surface-variant">Leave blank to use a random available port.</p>
            </>
          )}
        </ScopedField>

        <ScopedField
          path="daemon.log_level"
          label="Log Level"
          defaultScope="local"
        >
          {({ value, onChange }) => (
            <Select value={value ?? 'info'} onValueChange={(v) => onChange(v as LogLevel)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ScopedField>

        <ScopedField
          path="daemon.log_retention_days"
          label="Log Retention (days)"
          defaultScope="local"
          commitOn="blur"
        >
          {({ value, onChange, onBlur }) => (
            <Input
              type="number"
              min={1}
              max={365}
              className="w-24"
              value={value ?? ''}
              onChange={(e) => onChange(Number(e.target.value))}
              onBlur={onBlur}
            />
          )}
        </ScopedField>
      </div>
    </Surface>
  );
}
