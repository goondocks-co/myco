// @vitest-environment jsdom

/**
 * `TaskProviderConfig`'s bespoke hooks (`useTaskConfig`/`useUpdateTaskConfig`,
 * `use-providers.ts`) bound to a Team target — proves they branch to the
 * team-write route `GET/PUT /api/team/agent-tasks/:id/config` (server-mode
 * design spec §6.3, the per-task table gap `gotcha-ac176626` tracked) when
 * rendered inside a `TeamConfigTargetProvider`, exactly the way
 * `use-scoped-config.tsx`'s `useTeamConfig` already does for `/team/config`.
 *
 * Mocks only `lib/api` + the heavy provider-UI leaf components (model
 * discovery, reasoning profiles, provider-config-draft) — `use-providers.ts`
 * itself stays REAL, so the assertions below prove the actual request shape
 * (path, body, headers) a fetch/save produces, not a mocked shell. Mirrors
 * `tests/ui/team-settings-panel.test.tsx`'s own stated philosophy.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';

const fetchJsonMock = vi.fn();
const putJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  putJson: (...args: unknown[]) => putJsonMock(...args),
  postJson: vi.fn(),
  deleteJson: vi.fn(),
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

mock.module('../../packages/myco/ui/src/hooks/use-models', () => ({
  useModels: () => ({ data: { models: [] }, isPending: false }),
}));

const providerDraft = {
  type: 'anthropic', harness: 'claude-sdk', model: '', localBackend: '', baseUrl: '',
  contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '',
};

mock.module('../../packages/myco/ui/src/hooks/use-provider-config-draft', () => ({
  draftToNormalizedProviderConfig: () => ({ type: 'anthropic', model: '' }),
  providerDraftFromSource: () => providerDraft,
  useProviderConfigDraft: () => ({
    draft: providerDraft,
    savedDraft: providerDraft,
    isDirty: true,
    clearDraft: vi.fn(),
    resetDraft: vi.fn(),
    commitDraft: vi.fn(),
    handleHarnessChange: vi.fn(),
    handleProviderChange: vi.fn(),
    handleModelChange: vi.fn(),
    handleLocalBackendChange: vi.fn(),
    handleReasoningChange: vi.fn(),
    handleBaseUrlChange: vi.fn(),
    handleContextLengthChange: vi.fn(),
  }),
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

import { TaskProviderConfig } from '../../packages/myco/ui/src/components/agent/TaskProviderConfig';
import { TeamConfigTargetProvider } from '../../packages/myco/ui/src/hooks/use-scoped-config';
import type { TeamConfigTarget } from '../../packages/myco/ui/src/hooks/use-scoped-config';

const CARRIER_TARGET: TeamConfigTarget = { carrier: { hostId: 'host_x' } };
const SELF_TARGET: TeamConfigTarget = { carrier: null };
const TASK_ROUTE = '/team/agent-tasks/vault-evolve/config';
// A carried target names the DESTINATION HOST (PR #802) and pins grove/project
// to explicit empty so an ambient project selection can't shadow the host-id
// branch at the server chokepoint.
const CARRIER_HEADERS = { 'x-myco-host-id': 'host_x', 'x-myco-grove-id': '', 'x-myco-project-id': '' };

function stubTaskConfig() {
  fetchJsonMock.mockImplementation(async (path: string) => {
    if (path === '/providers') return { providers: [] };
    if (path === TASK_ROUTE) {
      return { taskId: 'vault-evolve', config: null, capability: null, capabilityEnabled: true, effectiveScheduleEnabled: false };
    }
    throw new Error(`unexpected fetchJson call: ${path}`);
  });
}

function renderTeamTaskConfig(target: TeamConfigTarget = CARRIER_TARGET) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TeamConfigTargetProvider target={target}>
        <TaskProviderConfig taskId="vault-evolve" />
      </TeamConfigTargetProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchJsonMock.mockReset();
  putJsonMock.mockReset();
});

describe('TaskProviderConfig bound to a team target (per-task table, server-mode design spec §6.3)', () => {
  it('fetches GET /team/agent-tasks/:id/config with carrier headers on mount, never the bespoke /agent/tasks route', async () => {
    stubTaskConfig();
    renderTeamTaskConfig();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith(
      TASK_ROUTE,
      expect.objectContaining({ headers: CARRIER_HEADERS }),
    ));
    expect(fetchJsonMock).not.toHaveBeenCalledWith('/agent/tasks/vault-evolve/config', expect.anything());
  });

  it('a "This machine" target (no carrier) sends explicit empty grove/project headers', async () => {
    stubTaskConfig();
    renderTeamTaskConfig(SELF_TARGET);

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith(
      TASK_ROUTE,
      expect.objectContaining({ headers: { 'x-myco-grove-id': '', 'x-myco-project-id': '' } }),
    ));
  });

  it('saving PUTs /team/agent-tasks/:id/config with carrier headers — the save round-trip', async () => {
    stubTaskConfig();
    putJsonMock.mockResolvedValue({ taskId: 'vault-evolve', config: { provider: { type: 'anthropic' } } });

    renderTeamTaskConfig();
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith(TASK_ROUTE, expect.anything()));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(putJsonMock).toHaveBeenCalledWith(
      TASK_ROUTE,
      expect.any(Object),
      { headers: CARRIER_HEADERS },
    ));
    // Never the bespoke config-lock-stamped route.
    expect(putJsonMock).not.toHaveBeenCalledWith('/agent/tasks/vault-evolve/config', expect.anything(), expect.anything());
  });

  it('outside any TeamConfigTargetProvider, falls back to the bespoke project-scoped route', async () => {
    fetchJsonMock.mockImplementation(async (path: string) => {
      if (path === '/providers') return { providers: [] };
      if (path === '/agent/tasks/vault-evolve/config') {
        return { taskId: 'vault-evolve', config: null, capability: null, capabilityEnabled: true, effectiveScheduleEnabled: false };
      }
      throw new Error(`unexpected fetchJson call: ${path}`);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TaskProviderConfig taskId="vault-evolve" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/agent/tasks/vault-evolve/config', expect.anything()));
  });
});
