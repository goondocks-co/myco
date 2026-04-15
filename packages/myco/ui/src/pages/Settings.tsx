import { useState, useCallback, useEffect } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useDaemon } from '../hooks/use-daemon';
import {
  useProviders,
  useTestProvider,
  seedDraftFromProviderType,
  draftToProviderConfig,
  type ProviderDraft,
} from '../hooks/use-providers';
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
import { Switch } from '../components/ui/switch';
import { PlanCaptureCard } from '../components/config/PlanCaptureCard';
import { ScopedField } from '../components/config/ScopedField';
import { ScopePill } from '../components/config/ScopePill';
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

function providerToDraft(p: { type?: string; model?: string; base_url?: string; context_length?: number } | undefined): ProviderDraft {
  return {
    type: (p?.type as ProviderDraft['type']) ?? '',
    model: p?.model ?? '',
    baseUrl: p?.base_url ?? '',
    contextLength: p?.context_length?.toString() ?? '',
  };
}

/** Myco Agent — personal-default. Provider type/model/base-url/context all
 *  live as the `agent.provider` object; each subfield writes via a nested
 *  scoped path. Two coupled writes use setFields:
 *    • setting a provider for the first time also enables both task toggles
 *    • Clear Provider also disables both task toggles
 *  These mirror the previous batched-Save behaviour but happen atomically. */
function AgentProviderCard() {
  const { effective, setField, setFields, setFieldsAndClear, isLocalOverride, resetField, promoteField } = useScopedConfig();
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const agentTestMutation = useTestProvider();

  const providers = providersData?.providers ?? [];
  const provider = effective?.agent?.provider;
  const [draft, setDraft] = useState<ProviderDraft>(() => providerToDraft(provider));

  // Re-sync when an external write changes the upstream value (other tab,
  // promote/reset). The ref-based `useScopedConfig` no longer churns
  // identities on every refetch, so this only fires on actual value change.
  useEffect(() => { setDraft(providerToDraft(provider)); }, [provider]);

  // Backfill the model when a legacy config has provider.type but no model.
  // /simplify Q1: previously this only mutated draft state, leaving the on-disk
  // value silently empty. Now it persists the chosen first-model so display
  // and config agree without requiring the user to "touch" the field.
  useEffect(() => {
    if (draft.type === '' || draft.model !== '' || !providersData) return;
    const firstModel = providers.find(p => p.type === draft.type)?.models?.[0];
    if (firstModel) {
      setDraft(prev => ({ ...prev, model: firstModel }));
      void setField('agent.provider.model', firstModel, 'local');
    }
  }, [draft.type, draft.model, providers, providersData, setField]);

  const personal = isLocalOverride('agent.provider');

  const writeProvider = useCallback((next: ProviderDraft, autoEnableTasks: boolean) => {
    const value = draftToProviderConfig(next);
    if (autoEnableTasks) {
      void setFields([
        { path: 'agent.provider', value },
        { path: 'agent.scheduled_tasks_enabled', value: true },
        { path: 'agent.event_tasks_enabled', value: true },
      ], 'local');
    } else {
      void setField('agent.provider', value, 'local');
    }
  }, [setField, setFields]);

  const handleProviderTypeChange = useCallback((type: string) => {
    const wasEmpty = draft.type === '';
    const next = seedDraftFromProviderType(type, providers);
    setDraft(next);
    agentTestMutation.reset();
    writeProvider(next, wasEmpty);
  }, [draft.type, providers, writeProvider, agentTestMutation]);

  const handleModelChange = useCallback((model: string) => {
    setDraft(prev => ({ ...prev, model }));
    if (draft.type !== '') void setField('agent.provider.model', model, 'local');
  }, [draft.type, setField]);

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setDraft(prev => ({ ...prev, baseUrl }));
    agentTestMutation.reset();
  }, [agentTestMutation]);

  const handleBaseUrlBlur = useCallback(() => {
    if (draft.type !== '') void setField('agent.provider.base_url', draft.baseUrl || undefined, 'local');
  }, [draft.type, draft.baseUrl, setField]);

  const handleContextLengthChange = useCallback((contextLength: string) => {
    setDraft(prev => ({ ...prev, contextLength }));
  }, []);

  const handleContextLengthBlur = useCallback(() => {
    if (draft.type !== '') {
      const n = draft.contextLength === '' ? undefined : Number(draft.contextLength);
      void setField('agent.provider.context_length', n, 'local');
    }
  }, [draft.type, draft.contextLength, setField]);

  const handleClear = useCallback(async () => {
    setDraft({ type: '', model: '', baseUrl: '', contextLength: '' });
    agentTestMutation.reset();
    // One atomic PUT: disables both task toggles AND clears the local
    // agent.provider override. Server applies clear-before-patch in a single
    // write, so there's no partial-failure window. A project-scoped provider
    // still requires editing myco.yaml directly.
    try {
      await setFieldsAndClear(
        [
          { path: 'agent.scheduled_tasks_enabled', value: false },
          { path: 'agent.event_tasks_enabled', value: false },
        ],
        ['agent.provider'],
        'local',
      );
    } catch (err) {
      console.error('[agent-card] clear provider failed', err);
    }
  }, [setFieldsAndClear, agentTestMutation]);

  const handleTestConnection = useCallback(() => {
    if (draft.type === '') return;
    agentTestMutation.mutate({
      type: draft.type,
      ...(draft.baseUrl ? { base_url: draft.baseUrl } : {}),
    });
  }, [draft.type, draft.baseUrl, agentTestMutation]);

  return (
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
      <SectionHeader>
        <span className="flex items-center gap-2">
          Myco Agent
          {personal && <ScopePill onPromote={() => promoteField('agent.provider')} onReset={() => resetField('agent.provider')} />}
        </span>
      </SectionHeader>

      {draft.type === '' ? (
        <p className="font-sans text-sm text-on-surface-variant">
          No provider configured -- data collection is active. Configure a provider
          to enable the intelligence pipeline.
        </p>
      ) : null}

      <ProviderModelSelector
        providerType={draft.type}
        model={draft.model}
        baseUrl={draft.baseUrl}
        contextLength={draft.contextLength}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
        onProviderChange={handleProviderTypeChange}
        onModelChange={handleModelChange}
        onBaseUrlChange={handleBaseUrlChange}
        onContextLengthChange={handleContextLengthChange}
        onBaseUrlBlur={handleBaseUrlBlur}
        onContextLengthBlur={handleContextLengthBlur}
      />

      {draft.type !== '' && (
        <>
          <div className="flex items-center gap-3 pt-1">
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
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="text-xs text-on-surface-variant"
          >
            Clear provider
          </Button>
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
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-ochre">
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
              <Select value={value ?? ''} onValueChange={onChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {embeddingModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      <span className="font-mono text-sm">{m}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-ochre">
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
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
      <SectionHeader>Project</SectionHeader>

      <div className="space-y-4">
        {/* Vault name -- read-only */}
        <div className="space-y-1.5">
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
