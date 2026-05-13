import { useState, useCallback, useEffect, type ReactNode } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import {
  CONFIG_SECTION_IDS,
} from '@myco/config/focus';
import {
  defaultBaseUrlForProvider,
  useProviders,
  useTestProvider,
  maybeInferHarnessFromProviderType,
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
import { ReasoningProfiles } from '../components/providers/ReasoningProfiles';

type Provider = 'ollama' | 'openai-compatible';

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

type TestState = 'idle' | 'testing' | 'success' | 'error';
type AgentSecretProvider = Extract<SecretProvider, 'openai' | 'openrouter'>;
type MonorepoReleaseMappingEntry = {
  path_glob: string;
  tag_pattern: string;
};

/* ---------- Page ---------- */

export default function Settings() {
  const { effective, isLoading } = useScopedConfig();

  if (isLoading || !effective) {
    return (
      <div className="p-6">
        <PageHeader title="Settings" />
        <p className="font-sans text-sm text-on-surface-variant mt-2">Loading...</p>
      </div>
    );
  }

  return (
    <RestartGateProvider>
    <div className="p-6">
      <PageHeader
        title="Settings"
        subtitle="Project-scoped configuration. Personal overrides land in your local.yaml."
      />
      <p className="font-sans text-sm text-on-surface-variant mt-2 mb-4">
        Daemon and machine-wide settings live under <strong className="font-medium text-on-surface">System</strong>.
        Grove-wide settings (backups, maintenance, team) live under{' '}
        <strong className="font-medium text-on-surface">Grove Settings</strong>.
      </p>
      <RestartBanner />

      <div className="space-y-6">
        {/* ---- Top row: Myco Agent + Embedding side by side ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- Myco Agent section ---- */}
        <AgentProviderCard />

        {/* ---- Embedding section ---- */}
        <EmbeddingCard />
        </div>{/* end top row grid */}

        {/* ---- Notifications section ---- */}
        <NotificationSettings />

        {/* ---- Plan Capture section ---- */}
        <PlanCaptureCard />

        {/* ---- Release Provenance section ---- */}
        <ReleaseProvenanceCard />
      </div>
    </div>
    </RestartGateProvider>
  );
}

const REMOTE_SECRET_LABELS: Record<AgentSecretProvider, string> = {
  openai: 'OpenAI API Key',
  openrouter: 'OpenRouter API Key',
};

function parseStringList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function StringListTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string[] | undefined;
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const serialized = (value ?? []).join('\n');
  const [draft, setDraft] = useState(serialized);

  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  return (
    <textarea
      className="min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-on-surface shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onChange(parseStringList(draft))}
    />
  );
}

function parseMonorepoReleaseMapping(value: string): MonorepoReleaseMappingEntry[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pathGlob, tagPattern] = line.split(/\s*(?:=>|=)\s*/, 2);
      return {
        path_glob: pathGlob?.trim() ?? '',
        tag_pattern: tagPattern?.trim() ?? '',
      };
    })
    .filter((entry) => entry.path_glob && entry.tag_pattern);
}

function MonorepoReleaseMappingTextarea({
  value,
  onChange,
}: {
  value: MonorepoReleaseMappingEntry[] | undefined;
  onChange: (value: MonorepoReleaseMappingEntry[]) => void;
}) {
  const serialized = (value ?? [])
    .map((entry) => `${entry.path_glob} => ${entry.tag_pattern}`)
    .join('\n');
  const [draft, setDraft] = useState(serialized);

  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  return (
    <textarea
      className="min-h-20 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-on-surface shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      value={draft}
      placeholder="packages/api/ => refs/tags/api/v*"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onChange(parseMonorepoReleaseMapping(draft))}
    />
  );
}

function FieldNote({ children }: { children: string }) {
  return <p className="font-sans text-xs leading-5 text-on-surface-variant">{children}</p>;
}

function ReleaseSettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-outline-variant/20 pt-5">
      <div className="space-y-1">
        <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          {title}
        </h3>
        <FieldNote>{description}</FieldNote>
      </div>
      {children}
    </section>
  );
}

function isSecretProvider(type: ProviderDraft['type']): type is AgentSecretProvider {
  return type === 'openai' || type === 'openrouter';
}

function ReleaseProvenanceCard() {
  const { effective, setFields } = useScopedConfig();
  const { data: providerSecretsData } = useProviderSecrets();
  const saveProviderSecret = useSaveProviderSecret();
  const deleteProviderSecret = useDeleteProviderSecret();
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const repoName = effective?.release_provenance.github.repo.split('/').pop()?.replace(/\.git$/, '') || 'project';
  const projectTagRef = `refs/tags/${repoName}/v*`;
  const githubSecret = providerSecretsData?.secrets.github;
  const githubTokenStatus = githubSecret?.configured
    ? `${githubSecret.maskedValue ?? 'GitHub access'} connected for PR evidence.`
    : 'Required for private repos and reliable squash-merge matches.';

  const applyPreset = useCallback((productionRefs: string[], integrationRefs: string[]) => {
    void setFields([
      { path: 'release_provenance.production_refs', value: productionRefs },
      { path: 'release_provenance.integration_refs', value: integrationRefs },
    ], 'project').catch((err) => console.error('[settings] release provenance preset failed', err));
  }, [setFields]);

  const handleSaveGithubToken = useCallback(() => {
    const trimmed = githubTokenInput.trim();
    if (!trimmed) return;
    saveProviderSecret.mutate({ provider: 'github', apiKey: trimmed }, {
      onSuccess: () => setGithubTokenInput(''),
    });
  }, [githubTokenInput, saveProviderSecret]);

  const handleClearGithubToken = useCallback(() => {
    deleteProviderSecret.mutate({ provider: 'github' });
  }, [deleteProviderSecret]);

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-6">
      <div className="max-w-4xl space-y-2">
        <SectionHeader>Release provenance</SectionHeader>
        <p className="font-sans text-sm text-on-surface-variant">
          Myco uses Git evidence to tell whether captured knowledge is released, merged but unreleased, or still only local.
        </p>
      </div>

      <ReleaseSettingsSection
        title="Release model"
        description="Define what counts as released and what counts as merged for this project."
      >
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(['refs/tags/v*'], ['origin/main'])}>
            Semver tags
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset([projectTagRef], ['origin/main'])}>
            Project tag family
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(['origin/main'], [])}>
            Main branch deploys
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ScopedField
            path="release_provenance.production_refs"
            label="Production refs"
            hint="one per line"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <StringListTextarea
                  value={value ?? []}
                  onChange={onChange}
                  placeholder="refs/tags/v*"
                />
                <FieldNote>Refs that mean code is released. Use release tags, project tag families, or the branch that deploys directly.</FieldNote>
              </div>
            )}
          </ScopedField>

          <ScopedField
            path="release_provenance.integration_refs"
            label="Integration refs"
            hint="one per line"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <StringListTextarea
                  value={value ?? []}
                  onChange={onChange}
                  placeholder="origin/main"
                />
                <FieldNote>Refs that mean work is merged but not necessarily released. For GitHub projects this is usually the default branch.</FieldNote>
              </div>
            )}
          </ScopedField>
        </div>
      </ReleaseSettingsSection>

      <ReleaseSettingsSection
        title="GitHub evidence"
        description="Optional PR evidence improves reconciliation when squash merges hide direct commit ancestry."
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,1fr)_12rem]">
          <ScopedField
            path="release_provenance.github.repo"
            label="Repository"
            hint="owner/name"
            lockScope="project"
            commitOn="blur"
          >
            {({ value, onChange, onBlur }) => (
              <div className="space-y-2">
                <Input
                  value={value ?? ''}
                  placeholder="owner/name"
                  onChange={(event) => onChange(event.target.value)}
                  onBlur={onBlur}
                />
                <FieldNote>Detected from the GitHub remote when possible. Leave blank to disable GitHub PR evidence.</FieldNote>
              </div>
            )}
          </ScopedField>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="font-sans text-sm font-medium text-on-surface">Access token</label>
              <ScopeBadge scope="machine" />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="min-w-0 flex-1"
                type="password"
                value={githubTokenInput}
                placeholder={githubSecret?.configured ? 'Paste new GitHub token' : 'Paste GitHub token'}
                onChange={(event) => setGithubTokenInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSaveGithubToken();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                onClick={handleSaveGithubToken}
                disabled={saveProviderSecret.isPending || githubTokenInput.trim() === ''}
              >
                {saveProviderSecret.isPending ? 'Saving' : githubSecret?.configured ? 'Update' : 'Connect'}
              </Button>
              {githubSecret?.configured && githubSecret.source !== 'env' && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleClearGithubToken}
                  disabled={deleteProviderSecret.isPending}
                >
                  Clear
                </Button>
              )}
            </div>
            <FieldNote>{githubTokenStatus}</FieldNote>
          </div>

          <ScopedField
            path="release_provenance.github.max_lookups_per_run"
            label="PR lookups"
            lockScope="project"
            commitOn="blur"
            parse={(value) => Number(value)}
          >
            {({ value, onChange, onBlur }) => (
              <div className="space-y-2">
                <Input
                  type="number"
                  min={0}
                  max={200}
                  value={String(value ?? 20)}
                  onChange={(event) => onChange(Number(event.target.value))}
                  onBlur={onBlur}
                />
                <FieldNote>Maximum GitHub PR searches per reconcile run. Higher values can improve older squash-merge matches but use more API quota.</FieldNote>
              </div>
            )}
          </ScopedField>
        </div>
      </ReleaseSettingsSection>

      <ReleaseSettingsSection
        title="Reconciliation behavior"
        description="Control whether provenance runs, how often it refreshes, and how unknown Git states are treated."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ScopedField
            path="release_provenance.enabled"
            label="Enabled"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <Switch checked={value ?? true} onCheckedChange={onChange} />
                <FieldNote>Enabled by default for Git projects. Missing refs leave records unreconciled instead of guessed.</FieldNote>
              </div>
            )}
          </ScopedField>

          <ScopedField
            path="release_provenance.reconcile_interval_minutes"
            label="Reconcile interval"
            hint="minutes"
            defaultScope="project"
            commitOn="blur"
            parse={(value) => Number(value)}
          >
            {({ value, onChange, onBlur }) => (
              <div className="space-y-2">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={String(value ?? 15)}
                  onChange={(event) => onChange(Number(event.target.value))}
                  onBlur={onBlur}
                />
                <FieldNote>How often the daemon rechecks captured Git evidence against the release model.</FieldNote>
              </div>
            )}
          </ScopedField>

          <ScopedField
            path="release_provenance.production_debug_include_unknown"
            label="Include unknown debug"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <Switch checked={value ?? true} onCheckedChange={onChange} />
                <FieldNote>Include dirty worktrees and other unknown Git states in production-scoped debug context.</FieldNote>
              </div>
            )}
          </ScopedField>
        </div>
      </ReleaseSettingsSection>

      <ReleaseSettingsSection
        title="Advanced monorepo releases"
        description="Use this only when different paths in one repository release through different tag families."
      >
        <ScopedField
          path="release_provenance.package_map"
          label="Monorepo release mapping"
          hint="path => release tag ref"
          lockScope="project"
        >
          {({ value, onChange }) => (
            <div className="space-y-2">
              <MonorepoReleaseMappingTextarea value={value ?? []} onChange={onChange} />
              <FieldNote>Map a path prefix to the tag pattern that releases that part of the repository.</FieldNote>
            </div>
          )}
        </ScopedField>
      </ReleaseSettingsSection>
    </Surface>
  );
}

/** Myco Agent — personal-default. Provider configuration is staged locally
 *  and saved explicitly because harness -> provider -> model -> reasoning is
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
  const agentHarness = effective?.agent?.harness;
  const {
    draft,
    savedDraft,
    isDirty,
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

  const personal = isLocalOverride('agent.provider') || isLocalOverride('agent.harness');
  const handleResetScope = useCallback(async () => {
    if (isLocalOverride('agent.harness')) {
      await resetField('agent.harness');
    }
    if (isLocalOverride('agent.provider')) {
      await resetField('agent.provider');
    }
  }, [isLocalOverride, resetField]);
  const handlePromoteScope = useCallback(async () => {
    if (isLocalOverride('agent.harness')) {
      await promoteField('agent.harness');
    }
    if (isLocalOverride('agent.provider')) {
      await promoteField('agent.provider');
    }
  }, [isLocalOverride, promoteField]);

  const writeProvider = useCallback((next: ProviderDraft, autoEnableTasks: boolean) => {
    const value = draftToNormalizedProviderConfig(next, reasoningModels);
    const fields: Array<{ path: 'agent.harness' | 'agent.provider' | 'agent.scheduled_tasks_enabled' | 'agent.event_tasks_enabled'; value: unknown }> = [
      { path: 'agent.harness', value: next.harness || maybeInferHarnessFromProviderType(next.type) },
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
          ['agent.provider', 'agent.harness'],
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
        harness={draft.harness}
        providerType={draft.type}
        localBackend={draft.localBackend}
        model={draft.model}
        baseUrl={draft.baseUrl}
        contextLength={draft.contextLength}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
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
