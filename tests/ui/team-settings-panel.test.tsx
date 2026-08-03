// @vitest-environment jsdom

/**
 * `TeamSettingsPanel` (Task 9) — mounts the SAME `AgentProviderCard` /
 * `EmbeddingCard` forms the project Settings page uses, bound to a served
 * grove through Task 8's team routes instead of the ambient project
 * selection. Unlike `tests/ui/settings-page.test.tsx` (which mocks
 * `use-scoped-config` wholesale), this file mocks only `lib/api` and leaves
 * the real `use-scoped-config` / `use-provider-secrets` team wiring in
 * place — so these tests prove the actual request shapes (path, body,
 * headers) a save produces, not a mocked shell. Heavy provider-UI internals
 * unrelated to team wiring (model discovery, reasoning profiles) are
 * stubbed to keep the surface focused.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';

const fetchJsonMock = vi.fn();
const putJsonMock = vi.fn();
const postJsonMock = vi.fn();
const deleteJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  putJson: (...args: unknown[]) => putJsonMock(...args),
  postJson: (...args: unknown[]) => postJsonMock(...args),
  deleteJson: (...args: unknown[]) => deleteJsonMock(...args),
  patchJson: vi.fn(),
  fetchMergedConfig: vi.fn().mockResolvedValue({}),
  fetchLocalConfig: vi.fn().mockResolvedValue({}),
  writeScopedConfig: vi.fn().mockResolvedValue({}),
  clearLocalConfigKeys: vi.fn().mockResolvedValue({}),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`API error ${status}`);
      this.status = status;
      this.body = body;
    }
  },
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => null,
  useProjectScopedQueryKey: (key: unknown) => key,
}));

mock.module('../../packages/myco/ui/src/hooks/use-grove-config', () => ({
  useUpdateGroveConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-machine-config', () => ({
  useUpdateMachineConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const updateTaskConfigMutateMock = vi.fn();

// Hoisted so every mock call returns the SAME reference — real `useQuery`
// (and the real `useAgentTasks`/`useTask`) keep `data` referentially stable
// across renders until it actually changes; a mock that hands back a fresh
// object/array every call breaks that invariant and can infinite-loop a
// `useEffect` keyed on the object (`TaskProviderConfig`'s config-sync effect
// hit exactly this before these were hoisted).
const STUB_TASK_CONFIG_DATA = {
  taskId: 'vault-evolve', config: null, capability: null, capabilityEnabled: true, effectiveScheduleEnabled: false,
};
const STUB_TASK = { name: 'vault-evolve', displayName: 'Vault Evolve', description: '', agent: 'myco-agent', prompt: '', isDefault: false };
const STUB_TASKS_RESPONSE = { tasks: [STUB_TASK] };
const STUB_TASK_DETAIL_RESPONSE = { task: STUB_TASK };
const STUB_INHERITED_EXECUTION = {};

mock.module('../../packages/myco/ui/src/hooks/use-providers', () => ({
  useProviders: () => ({ data: { providers: [{ type: 'anthropic', label: 'Anthropic', models: [] }] }, isPending: false }),
  useTestProvider: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, isError: false }),
  // Per-task table (TeamTaskProviderConfig / TaskProviderConfig) — stubbed
  // here since the real branching behavior is proven at the hook level in
  // tests/ui/team-task-provider-config.test.tsx; this file only needs the
  // table to render and mount the reused form.
  useTaskConfig: () => ({ data: STUB_TASK_CONFIG_DATA }),
  useUpdateTaskConfig: () => ({ mutate: updateTaskConfigMutateMock, isPending: false }),
  getInheritedExecution: () => STUB_INHERITED_EXECUTION,
  parseProviderType: (value: string) => value,
  resolveReasoningModel: () => '',
  defaultBaseUrlForProvider: () => '',
  maybeInferHarnessFromProviderType: () => 'claude-sdk',
  REASONING_LEVELS: ['low', 'default', 'high'],
}));

mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentTasks: () => ({ data: STUB_TASKS_RESPONSE, isPending: false }),
  useTask: () => ({ data: STUB_TASK_DETAIL_RESPONSE }),
}));

const providerDraft = {
  type: 'openai', harness: 'claude-sdk', model: '', localBackend: '', baseUrl: '',
  contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '',
};

mock.module('../../packages/myco/ui/src/hooks/use-provider-config-draft', () => ({
  draftToNormalizedProviderConfig: () => ({ type: 'openai', model: '' }),
  providerDraftFromSource: () => providerDraft,
  useProviderConfigDraft: () => ({
    draft: providerDraft,
    savedDraft: providerDraft,
    isDirty: false,
    clearDraft: vi.fn(),
    resetDraft: vi.fn(),
    handleHarnessChange: vi.fn(),
    handleProviderChange: vi.fn(),
    handleModelChange: vi.fn(),
    handleLocalBackendChange: vi.fn(),
    handleReasoningChange: vi.fn(),
    handleBaseUrlChange: vi.fn(),
    handleContextLengthChange: vi.fn(),
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-models', () => ({
  useModels: () => ({ data: { models: [] }, isPending: false }),
}));

mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/AdvancedModelPin', () => ({
  AdvancedModelPin: () => null,
}));

import { TeamSettingsPanel } from '../../packages/myco/ui/src/components/team/TeamSettingsPanel';
import type { TeamConfigTarget } from '../../packages/myco/ui/src/hooks/use-scoped-config';

const CARRIER_TARGET: TeamConfigTarget = { carrier: { hostId: 'host_x' } };
const SELF_TARGET: TeamConfigTarget = { carrier: null };
// A carried target names the DESTINATION HOST (PR #802); grove/project ride
// along as explicit empty so an ambient project selection can't shadow the
// host-id branch at the server chokepoint.
const CARRIER_HEADERS = { 'x-myco-host-id': 'host_x', 'x-myco-grove-id': '', 'x-myco-project-id': '' };

function renderPanel(target: TeamConfigTarget = CARRIER_TARGET) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TeamSettingsPanel target={target} />
    </QueryClientProvider>,
  );
}

function stubTeamConfig(keyHealth: 'ok' | 'missing_key') {
  fetchJsonMock.mockImplementation(async (path: string) => {
    if (path === '/team/config') {
      return {
        groveId: 'grove_x',
        config: {
          agent: { provider: { type: 'openai', model: '' }, harness: 'claude-sdk' },
          embedding: { provider: 'ollama', model: '', base_url: '' },
        },
        keyHealth,
      };
    }
    throw new Error(`unexpected fetchJson call: ${path}`);
  });
}

beforeEach(() => {
  fetchJsonMock.mockReset();
  putJsonMock.mockReset();
  postJsonMock.mockReset();
  deleteJsonMock.mockReset();
  updateTaskConfigMutateMock.mockReset();
});

describe('TeamSettingsPanel', () => {
  it('renders the reused Agent + Embedding forms bound to the team target and requests /team/config with carrier headers', async () => {
    stubTeamConfig('missing_key');
    renderPanel();

    await waitFor(() => expect(screen.getByText(/no team key configured/i)).toBeInTheDocument());
    expect(fetchJsonMock).toHaveBeenCalledWith('/team/config', expect.objectContaining({
      headers: CARRIER_HEADERS,
    }));
    expect(screen.getByText('Myco Agent')).toBeInTheDocument();
    expect(screen.getByText('Embedding')).toBeInTheDocument();
  });

  it('shows "A team key is configured." when keyHealth is ok', async () => {
    stubTeamConfig('ok');
    renderPanel();
    await waitFor(() => expect(screen.getByText(/a team key is configured/i)).toBeInTheDocument());
  });

  it('a "This machine" target (no carrier) sends explicit empty grove/project headers', async () => {
    stubTeamConfig('missing_key');
    renderPanel(SELF_TARGET);

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/team/config', expect.objectContaining({
      headers: { 'x-myco-grove-id': '', 'x-myco-project-id': '' },
    })));
  });

  it('saving a provider key PUTs /team/secrets/:provider with carrier headers and echoes the masked value only — never the raw key', async () => {
    stubTeamConfig('missing_key');
    putJsonMock.mockResolvedValue({ provider: 'openai', maskedValue: 'sk-1234****WXYZ' });

    renderPanel();

    const input = await screen.findByPlaceholderText(/paste api key/i);
    fireEvent.change(input, { target: { value: 'sk-1234REALSECRETVALUEWXYZ' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => expect(putJsonMock).toHaveBeenCalledWith(
      '/team/secrets/openai',
      { secret: 'sk-1234REALSECRETVALUEWXYZ' },
      { headers: CARRIER_HEADERS },
    ));

    await waitFor(() => expect(screen.getByText(/sk-1234\*+WXYZ/)).toBeInTheDocument());
    expect(screen.getByText(/from team secrets/i)).toBeInTheDocument();
    expect(screen.queryByText('sk-1234REALSECRETVALUEWXYZ')).not.toBeInTheDocument();
  });

  it('saving an ANTHROPIC provider key in team mode PUTs /team/secrets/anthropic with carrier headers — the spec-default provider that project mode has no key field for', async () => {
    stubTeamConfig('missing_key');
    putJsonMock.mockResolvedValue({ provider: 'anthropic', maskedValue: 'sk-ant-****WXYZ' });
    const originalType = providerDraft.type;
    providerDraft.type = 'anthropic';

    try {
      renderPanel();

      const input = await screen.findByPlaceholderText(/paste api key/i);
      fireEvent.change(input, { target: { value: 'sk-ant-REALSECRETVALUEWXYZ' } });
      fireEvent.click(screen.getByRole('button', { name: /save key/i }));

      await waitFor(() => expect(putJsonMock).toHaveBeenCalledWith(
        '/team/secrets/anthropic',
        { secret: 'sk-ant-REALSECRETVALUEWXYZ' },
        { headers: CARRIER_HEADERS },
      ));

      await waitFor(() => expect(screen.getByText(/sk-ant-\*+WXYZ/)).toBeInTheDocument());
      expect(screen.queryByText('sk-ant-REALSECRETVALUEWXYZ')).not.toBeInTheDocument();
    } finally {
      providerDraft.type = originalType;
    }
  });

  it('deleting a provider key DELETEs /team/secrets/:provider (via fetchJson) and clears the masked echo', async () => {
    // The team DELETE path goes through fetchJson directly (deleteJson has no
    // headers param) — extend the /team/config stub to also answer the
    // DELETE call.
    fetchJsonMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/team/config') {
        return {
          groveId: 'grove_x',
          config: {
            agent: { provider: { type: 'openai', model: '' }, harness: 'claude-sdk' },
            embedding: { provider: 'ollama', model: '', base_url: '' },
          },
          keyHealth: 'missing_key',
        };
      }
      if (path === '/team/secrets/openai' && init?.method === 'DELETE') {
        return { provider: 'openai', maskedValue: null };
      }
      throw new Error(`unexpected fetchJson call: ${path}`);
    });
    putJsonMock.mockResolvedValue({ provider: 'openai', maskedValue: 'sk-1234****WXYZ' });

    renderPanel();

    const input = await screen.findByPlaceholderText(/paste api key/i);
    fireEvent.change(input, { target: { value: 'sk-1234REALSECRETVALUEWXYZ' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => expect(screen.getByText(/from team secrets/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /clear key/i }));

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith(
      '/team/secrets/openai',
      { method: 'DELETE', headers: CARRIER_HEADERS },
    ));
    await waitFor(() => expect(screen.queryByText(/from team secrets/i)).not.toBeInTheDocument());
  });

  it('mounts the per-task table (TaskProviderConfig) for the served grove, task picker + reused form', async () => {
    stubTeamConfig('missing_key');
    renderPanel();

    // Task picker lists the (unscoped, build-vendored) task defs and defaults
    // to the first one; the reused TaskProviderConfig form mounts beneath it,
    // wired to `useTaskConfig`/`useUpdateTaskConfig` (proven to branch to the
    // team-write route at the hook level in
    // tests/ui/team-task-provider-config.test.tsx).
    await waitFor(() => expect(screen.getByText('Vault Evolve')).toBeInTheDocument());
    expect(screen.getByText('Task Config')).toBeInTheDocument();
    expect(updateTaskConfigMutateMock).not.toHaveBeenCalled();
  });

  it('owns no External access surface — that tab is its own panel now (E1 §5.2)', async () => {
    stubTeamConfig('ok');
    renderPanel();

    await screen.findByText('Team settings');
    // The whole external surface moved to `ExternalAccessPanel` (Tab 2). If
    // any of it reappears here the page would render it TWICE once both tabs
    // are open, each toggling a different host.
    expect(screen.queryByText('External access')).toBeNull();
    expect(screen.queryByRole('button', { name: /external access/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /rotate token/i })).toBeNull();
    expect(fetchJsonMock).not.toHaveBeenCalledWith('/team/external-mcp', expect.anything());
  });
});
