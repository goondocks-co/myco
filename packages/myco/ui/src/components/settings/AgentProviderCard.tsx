import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import {
  defaultBaseUrlForProvider,
  maybeInferHarnessFromProviderType,
  useProviders,
  useTestProvider,
} from '../../hooks/use-providers';
import { REASONING_LEVELS } from '../../hooks/use-providers';
import type { ProviderDraft, ReasoningLevelUi } from '../../hooks/use-providers';
import {
  draftToNormalizedProviderConfig,
  useProviderConfigDraft,
} from '../../hooks/use-provider-config-draft';
import {
  useDeleteProviderSecret,
  useProviderSecrets,
  useSaveProviderSecret,
  type SecretProvider,
} from '../../hooks/use-provider-secrets';
import { useModels } from '../../hooks/use-models';
import { useScopedConfig } from '../../hooks/use-scoped-config';
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
import { ScopePill } from '../config/ScopePill';
import { ProviderModelSelector } from '../providers/ProviderModelSelector';
import { AdvancedModelPin } from '../providers/AdvancedModelPin';
import { ReasoningProfiles } from '../providers/ReasoningProfiles';

type AgentSecretProvider = Extract<SecretProvider, 'openai' | 'openrouter'>;

const REMOTE_SECRET_LABELS: Record<AgentSecretProvider, string> = {
  openai: 'OpenAI API Key',
  openrouter: 'OpenRouter API Key',
};

function isSecretProvider(type: ProviderDraft['type']): type is AgentSecretProvider {
  return type === 'openai' || type === 'openrouter';
}

/** Myco Agent — Grove-default. Provider configuration is staged locally
 *  and saved explicitly because harness -> provider -> model -> reasoning is
 *  a dependency chain that cannot be persisted safely as independent writes.
 *  Two coupled writes use setFields:
 *    • setting a provider for the first time also enables both task toggles
 *    • clearing the provider disables both task toggles and removes overrides
 *  Default tier is Grove; the ScopePill offers hard opt-in to Personal. */
export function AgentProviderCard() {
  const { effective, setFields, isLocalOverride, resetFields } = useScopedConfig();
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const { data: providerSecretsData } = useProviderSecrets();
  const saveProviderSecret = useSaveProviderSecret();
  const deleteProviderSecret = useDeleteProviderSecret();
  const agentTestMutation = useTestProvider();

  const providers = providersData?.providers ?? [];
  const provider = effective?.agent?.provider;
  const agentHarness = effective?.agent?.harness;
  const {
    draft,
    savedDraft,
    isDirty: isProviderDirty,
    clearDraft,
    resetDraft,
    handleHarnessChange,
    handleProviderChange,
    handleModelChange,
    handleLocalBackendChange,
    handleReasoningChange,
    handleBaseUrlChange,
    handleContextLengthChange,
  } = useProviderConfigDraft({
    source: {
      harness: agentHarness,
      provider,
    },
    providers,
  });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const secretProvider = isSecretProvider(draft.type) ? draft.type : null;
  const activeSecret = secretProvider ? providerSecretsData?.secrets[secretProvider] : undefined;
  const resolvedAgentBaseUrl = draft.baseUrl || defaultBaseUrlForProvider(draft.type, draft.localBackend);
  const modelsQuery = useModels(draft.type || null, resolvedAgentBaseUrl || undefined, 'llm', draft.localBackend || null);
  const reasoningModels = modelsQuery.data?.models ?? providers.find((info) => info.type === draft.type)?.models ?? [];
  const supportsReasoningMap = draft.type !== '';
  useEffect(() => { setApiKeyInput(''); }, [draft.type]);

  // Grove-wide default reasoning tier. Tracked separately from the provider
  // draft (it lives at `agent.reasoningLevel`, not inside `agent.provider`),
  // mirroring how Task Config holds its reasoning level outside the draft. An
  // unset value is the built-in `default` tier, so it displays as 'default'.
  const savedReasoningLevel = effective?.agent?.reasoningLevel;
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevelUi>(savedReasoningLevel ?? 'default');
  useEffect(() => {
    setReasoningLevel(savedReasoningLevel ?? 'default');
  }, [savedReasoningLevel]);
  // One dirty signal across the whole card: the provider draft (harness,
  // provider, model, reasoning_map, …) OR the runtime's default reasoning tier.
  const isDirty = isProviderDirty || reasoningLevel !== (savedReasoningLevel ?? 'default');

  const personal = isLocalOverride('agent.provider') || isLocalOverride('agent.harness');
  const handleResetScope = useCallback(async () => {
    const harness = isLocalOverride('agent.harness');
    const provider = isLocalOverride('agent.provider');
    if (harness && provider) { await resetFields(['agent.harness', 'agent.provider']); return; }
    if (harness) { await resetFields(['agent.harness']); return; }
    if (provider) { await resetFields(['agent.provider']); }
  }, [isLocalOverride, resetFields]);
  /** Hard opt-in: write the current effective values to local scope. */
  const handleSavePersonal = useCallback(async () => {
    const value = draftToNormalizedProviderConfig(draft, reasoningModels);
    await setFields(
      [
        { path: 'agent.harness', value: draft.harness || maybeInferHarnessFromProviderType(draft.type) },
        { path: 'agent.provider', value },
        { path: 'agent.reasoningLevel', value: reasoningLevel },
      ],
      'local',
    );
  }, [draft, reasoningLevel, reasoningModels, setFields]);

  const writeProvider = useCallback((next: ProviderDraft, autoEnableTasks: boolean) => {
    const value = draftToNormalizedProviderConfig(next, reasoningModels);
    const fields: Array<{ path: 'agent.harness' | 'agent.provider' | 'agent.reasoningLevel' | 'agent.scheduled_tasks_enabled' | 'agent.event_tasks_enabled'; value: unknown }> = [
      { path: 'agent.harness', value: next.harness || maybeInferHarnessFromProviderType(next.type) },
      { path: 'agent.provider', value },
      { path: 'agent.reasoningLevel', value: reasoningLevel },
    ];
    if (autoEnableTasks) {
      fields.push(
        { path: 'agent.scheduled_tasks_enabled', value: true },
        { path: 'agent.event_tasks_enabled', value: true },
      );
    }
    void setFields(fields, personal ? 'local' : 'grove');
  }, [personal, reasoningLevel, reasoningModels, setFields]);

  const handleClear = useCallback(() => {
    clearDraft();
    agentTestMutation.reset();
  }, [agentTestMutation, clearDraft]);

  const handleResetDraft = useCallback(() => {
    resetDraft();
    setReasoningLevel(savedReasoningLevel ?? 'default');
    agentTestMutation.reset();
  }, [agentTestMutation, resetDraft, savedReasoningLevel]);

  const handleSaveProvider = useCallback(async () => {
    const isClearingProvider = draft.type === '';
    if (isClearingProvider) {
      try {
        await setFields(
          [
            { path: 'agent.scheduled_tasks_enabled', value: false },
            { path: 'agent.event_tasks_enabled', value: false },
          ],
          personal ? 'local' : 'grove',
          ['agent.provider', 'agent.harness', 'agent.reasoningLevel'],
        );
      } catch (err) {
        console.error('[agent-card] clear provider failed', err);
      }
      return;
    }

    const shouldAutoEnableTasks = savedDraft.type === '' && draft.type !== '';
    writeProvider(draft, shouldAutoEnableTasks);
  }, [draft, personal, savedDraft.type, setFields, writeProvider]);

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
    deleteProviderSecret.mutate({ provider: secretProvider }, {
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
      ...(draft.type === 'openai-compatible' && draft.localBackend ? { local_backend: draft.localBackend } : {}),
      ...(draft.baseUrl ? { base_url: draft.baseUrl } : {}),
    });
  }, [draft.baseUrl, draft.localBackend, draft.type, agentTestMutation]);

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
          <ScopePill
            path="agent.provider"
            hasLocalOverride={personal}
            onSavePersonal={handleSavePersonal}
            onReset={handleResetScope}
          />
        </span>
      </SectionHeader>

      {draft.type === '' ? (
        <p className="font-sans text-sm text-on-surface-variant">
          No provider configured -- data collection is active. Configure a provider
          to enable the intelligence pipeline.
        </p>
      ) : null}

      <ProviderModelSelector
        harness={draft.harness}
        providerType={draft.type}
        localBackend={draft.localBackend}
        model={draft.model}
        baseUrl={draft.baseUrl}
        contextLength={draft.contextLength}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
        showModelSelector={false}
        onHarnessChange={(harness) => {
          handleHarnessChange(harness);
          agentTestMutation.reset();
        }}
        onProviderChange={(type) => {
          handleProviderChange(type);
          agentTestMutation.reset();
        }}
        onLocalBackendChange={(localBackend) => {
          handleLocalBackendChange(localBackend);
          agentTestMutation.reset();
        }}
        onModelChange={handleModelChange}
        onBaseUrlChange={handleBaseUrlChange}
        onContextLengthChange={handleContextLengthChange}
      />

      {supportsReasoningMap && (
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Default reasoning profile</label>
          <Select value={reasoningLevel} onValueChange={(val) => setReasoningLevel(val as ReasoningLevelUi)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_LEVELS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="font-sans text-[11px] text-on-surface-variant/70">
            Resolves to a model through the reasoning profiles below. Tasks may override per-task.
          </p>
        </div>
      )}

      {supportsReasoningMap && (
        <ReasoningProfiles
          description="Built-in tasks resolve `low`, `default`, and `high` reasoning phases through these model mappings."
          values={{
            low: draft.reasoningLow,
            default: draft.reasoningDefault,
            high: draft.reasoningHigh,
          }}
          onChange={handleReasoningChange}
          models={reasoningModels}
          fallbackModel={draft.model}
          placeholderWhenEmpty="Use default model"
        />
      )}

      {supportsReasoningMap && (
        <AdvancedModelPin
          providerType={draft.type}
          localBackend={draft.localBackend}
          baseUrl={draft.baseUrl}
          model={draft.model}
          providers={providers}
          onModelChange={handleModelChange}
        />
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
                ? `${activeSecret.maskedValue} from ${activeSecret.source === 'env' ? 'environment' : `${activeSecret.source} secrets`}`
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
