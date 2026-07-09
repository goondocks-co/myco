// @vitest-environment jsdom

/**
 * Settings page — OKF group (Task 5.2). OKF config (enable, synthesis
 * scope, output path, AGENTS.md pointer) moved off the OKF page onto the
 * unified Settings page as project-tier ScopedFields — see
 * tests/ui/okf-page.test.tsx for the OKF page's knowledge-first reshape.
 *
 * Mirrors the mock harness in tests/ui/settings-page.test.tsx (the whole
 * page renders every group, so custom-rendered groups need their own hooks
 * stubbed even though this test only exercises the OKF group).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';

/* ---------- Substrate state used by the mocks ---------- */

const projectSelectionRef: { current: { groveId: string; projectId: string } | null } = {
  current: { groveId: 'g1', projectId: 'p1' },
};

const setFieldMock = vi.fn();
const updateGroveMock = vi.fn();
const updateMachineMock = vi.fn();

const projectEffective: Record<string, unknown> = {
  agent: {
    provider: { type: '', model: '' },
    harness: '',
    scheduled_tasks_enabled: false,
    event_tasks_enabled: false,
  },
  embedding: { provider: 'ollama', model: 'bge-m3', base_url: '' },
  release_provenance: {
    enabled: true,
    production_refs: [],
    integration_refs: [],
    github: { repo: '', max_lookups_per_run: 20 },
    package_map: [],
  },
  notifications: { enabled: true, default_mode: 'banner', system_notifications: false },
  skills: { confidence_threshold: 0.8, usage_stale_days: 30 },
  capture: { transcript_paths: [], plan_dirs: [], artifact_extensions: [], buffer_max_events: 1000, ignore_plan_dirs_in_git: true },
  okf: {
    enabled: false,
    maintain: {
      output_path: 'okf',
      scope: { repo: true, git: true, vault: true },
      managed_agents_md_pointer: true,
    },
  },
};

const groveConfig: Record<string, unknown> = {
  daemon: { stale_session_threshold_ms: 3_600_000 },
  team: { enabled: false, interval_minutes: 10 },
  agent: { scheduled_tasks_active_window_days: 14 },
  maintenance: {
    auto_optimize: true,
    auto_optimize_interval_hours: 24,
    auto_integrity_check: false,
    auto_integrity_check_interval_hours: 168,
  },
  backup: { dir: '', auto_interval_hours: 24, retention: { keep_daily: 7, keep_weekly: 4 } },
  embedding: { run_in_deep_sleep: false },
  release_provenance: { reconcile_interval_minutes: 15 },
};

const machineConfig: Record<string, unknown> = {
  daemon: { log_level: 'info', log_retention_days: 30, update_channel: 'stable' },
};

/* ---------- Mocks ---------- */

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => projectSelectionRef.current,
  useProjectPath: (suffix = '') => suffix || '/',
  useProjectPathBuilder: () => (suffix = '') => suffix || '/',
  projectScopedQueryKey: (_sel: unknown, key: unknown) => key,
  useProjectScopedQueryKey: (key: unknown) => key,
  ProjectSelectionBoundary: ({ children }: { children: unknown }) => children,
  GlobalSelectionBoundary: ({ children }: { children: unknown }) => children,
}));

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: projectEffective,
    local: {},
    isLoading: false,
    isLocalOverride: () => false,
    setField: (...args: unknown[]) => setFieldMock(...args),
    setFields: vi.fn().mockResolvedValue(undefined),
    resetField: vi.fn().mockResolvedValue(undefined),
    promoteField: vi.fn().mockResolvedValue(undefined),
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-grove-config', () => ({
  useGroveConfig: () => ({
    data: { groveId: 'g1', config: groveConfig },
    isLoading: false,
    error: null,
  }),
  useUpdateGroveConfig: () => ({
    mutateAsync: (...args: unknown[]) => updateGroveMock(...args),
    isPending: false,
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-machine-config', () => ({
  useMachineConfig: () => ({
    data: { config: machineConfig },
    isLoading: false,
    error: null,
  }),
  useUpdateMachineConfig: () => ({
    mutateAsync: (...args: unknown[]) => updateMachineMock(...args),
    isPending: false,
  }),
  useAddToMachineConfigList: () => ({ mutate: () => {} }),
  useRemoveFromMachineConfigList: () => ({ mutate: () => {} }),
}));

// The Agent provider card depends on these hooks; stub them so the test
// doesn't hit the daemon. The card itself renders empty without a provider
// configured, which keeps the surface light.
mock.module('../../packages/myco/ui/src/hooks/use-providers', () => ({
  useProviders: () => ({ data: { providers: [] }, isPending: false }),
  useTestProvider: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, isError: false }),
  defaultBaseUrlForProvider: () => '',
  maybeInferHarnessFromProviderType: () => 'claude-code-sdk',
  REASONING_LEVELS: ['low', 'default', 'high'],
}));

mock.module('../../packages/myco/ui/src/hooks/use-provider-secrets', () => ({
  useProviderSecrets: () => ({ data: { secrets: {} } }),
  useSaveProviderSecret: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProviderSecret: () => ({ mutate: vi.fn(), isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-provider-config-draft', () => ({
  draftToNormalizedProviderConfig: () => ({}),
  useProviderConfigDraft: () => ({
    draft: { type: '', harness: '', model: '', localBackend: '', baseUrl: '', contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '' },
    savedDraft: { type: '', harness: '', model: '', localBackend: '', baseUrl: '', contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '' },
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

// Notifications card depends on a registry hook.
mock.module('../../packages/myco/ui/src/hooks/use-notifications', () => ({
  useNotificationRegistry: () => ({ data: { domains: [] }, isLoading: false }),
}));

// Restart hook used inside the restart-gate.
mock.module('../../packages/myco/ui/src/hooks/use-restart', () => ({
  useRestart: () => ({ mutate: vi.fn(), isPending: false }),
}));

// MachineIdentityRow (Logging group) reads useDaemon for the machine_id.
mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({
    data: { context: { request: { machine_id: 'test-machine' } } },
    isLoading: false,
    error: null,
  }),
}));

// PlanCaptureCard fetches symbiont plan dirs; BackupCard fetches /backups.
mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: vi.fn().mockImplementation(async (path: string) => {
    if (path === '/backups') return { backups: [] };
    return { symbiont: {} };
  }),
  postJson: vi.fn().mockResolvedValue({}),
  putJson: vi.fn().mockResolvedValue({}),
  patchJson: vi.fn().mockResolvedValue({}),
  deleteJson: vi.fn().mockResolvedValue({}),
  fetchMergedConfig: vi.fn().mockResolvedValue({}),
  fetchLocalConfig: vi.fn().mockResolvedValue({}),
  writeScopedConfig: vi.fn().mockResolvedValue({}),
  clearLocalConfigKeys: vi.fn().mockResolvedValue({}),
  ApiError: class ApiError extends Error {},
}));

// Stub heavy child renderers from the Agent card to keep the test light.
mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/NotificationSettings', () => ({
  NotificationSettings: () => <div data-testid="notification-settings" />,
}));

mock.module('../../packages/myco/ui/src/components/config/PlanCaptureCard', () => ({
  PlanCaptureCard: () => <div data-testid="plan-capture-card" />,
}));

mock.module('../../packages/myco/ui/src/components/operations/UpgradeCard', () => ({
  UpgradeCard: () => <div data-testid="upgrade-card" />,
}));
mock.module('../../packages/myco/ui/src/components/operations/BackupCard', () => ({
  BackupCard: () => <div data-testid="backup-card" />,
}));

// scrollIntoView isn't implemented in jsdom.
if (typeof Element !== 'undefined' && !(Element.prototype as { scrollIntoView?: () => void }).scrollIntoView) {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
}

// Imported AFTER the mocks so module-level imports resolve to stubs.
const { default: Settings } = await import('../../packages/myco/ui/src/pages/Settings');

function renderPage(initialRoute = '/settings') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings page — OKF group', () => {
  beforeEach(() => {
    setFieldMock.mockReset();
    setFieldMock.mockResolvedValue(undefined);
    projectSelectionRef.current = { groveId: 'g1', projectId: 'p1' };
  });

  it('renders an OKF section', () => {
    renderPage();
    const section = document.getElementById('okf');
    expect(section).toBeTruthy();
  });

  it('renders enable + output-path ScopedFields as project-scoped rows', () => {
    renderPage();
    const section = document.getElementById('okf') as HTMLElement;

    const enableLabel = screen.getByText('Enable OKF');
    expect(enableLabel).toBeInTheDocument();
    expect(section.textContent).toContain('okf.enabled');

    const outputPathLabel = screen.getByText('Output path');
    expect(outputPathLabel).toBeInTheDocument();
    expect(section.textContent).toContain('okf.maintain.output_path');

    // Synthesis scope + AGENTS.md pointer round out the config surface.
    expect(screen.getByText('Read repository files')).toBeInTheDocument();
    expect(screen.getByText('Read git history')).toBeInTheDocument();
    expect(screen.getByText('Read vault knowledge')).toBeInTheDocument();
    expect(screen.getByText('Maintain AGENTS.md pointer')).toBeInTheDocument();
  });

  it('toggling Enable OKF writes at PROJECT scope via setField', async () => {
    renderPage();
    const label = screen.getByText('Enable OKF');
    const row = label.closest('div')?.parentElement?.parentElement; // grid row
    expect(row).toBeTruthy();
    const sw = row?.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(sw).toBeTruthy();
    if (sw) fireEvent.click(sw);

    await waitFor(() => {
      expect(setFieldMock).toHaveBeenCalled();
    });
    expect(setFieldMock).toHaveBeenCalledWith('okf.enabled', true, 'project');
  });
});
