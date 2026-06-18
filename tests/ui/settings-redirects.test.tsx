// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MemoryRouter } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';

/* ---------- Substrate state used by the mocks ---------- */

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
  capture: {
    transcript_paths: [],
    plan_dirs: [],
    artifact_extensions: [],
    buffer_max_events: 1000,
    ignore_plan_dirs_in_git: true,
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

mock.module('../../packages/myco/ui/src/hooks/use-upgrade-status', () => ({
  useUpgradeStatus: () => ({ data: { exempt: false, update_available: false } }),
  useUpgradeCheck: () => ({ mutate: vi.fn(), isPending: false }),
  useUpgradeApply: () => ({ mutate: vi.fn(), isPending: false }),
  useUpgradeChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: null }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-restart', () => ({
  useRestart: () => ({ restart: vi.fn(), mutate: vi.fn(), isRestarting: false, isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-notifications', () => ({
  useUnreadCount: () => ({ data: { count: 0 } }),
  useNotificationRegistry: () => ({ data: { domains: [] }, isLoading: false }),
}));

mock.module('../../packages/myco/ui/src/components/search/GlobalSearch', () => ({
  GlobalSearch: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/NotificationBanner', () => ({
  NotificationBanner: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/NotificationPanel', () => ({
  NotificationPanel: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/SystemNotifications', () => ({
  SystemNotifications: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/NotificationSettings', () => ({
  NotificationSettings: () => <div data-testid="notification-settings" />,
}));

mock.module('../../packages/myco/ui/src/layout/AppearanceSection', () => ({
  AppearanceSection: () => null,
}));

mock.module('../../packages/myco/ui/src/hooks/use-git-identity', () => ({
  useGitIdentity: () => ({ data: null, isPending: false, isError: false }),
  gitIdentityInitials: (_author: string | undefined) => '??',
}));

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({
    data: {
      groves: [
        {
          id: 'grove-a',
          name: 'Work',
          slug: 'work',
          mode: 'local',
          is_default: true,
          created_at: '2026-01-01T00:00:00.000Z',
          project_count: 1,
          projects: [
            {
              project_id: 'project-a',
              name: 'Project A',
              slug: 'project-a-123abc',
              root: '/tmp/project-a',
              binding_id: 'gbind-a',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              manifest_state: 'present',
            },
          ],
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => {
  const scopedConfigStub = () => ({
    effective: projectEffective,
    local: {},
    isLoading: false,
    isLocalOverride: () => false,
    setField: vi.fn().mockResolvedValue(undefined),
    setFields: vi.fn().mockResolvedValue(undefined),
    resetField: vi.fn().mockResolvedValue(undefined),
    resetFields: vi.fn().mockResolvedValue(undefined),
    promoteField: vi.fn().mockResolvedValue(undefined),
  });
  return {
    useScopedConfig: scopedConfigStub,
    useScopedConfigForSelection: scopedConfigStub,
  };
});

mock.module('../../packages/myco/ui/src/hooks/use-grove-config', () => ({
  useGroveConfig: () => ({
    data: { groveId: 'grove-a', config: groveConfig },
    isLoading: false,
    error: null,
  }),
  useUpdateGroveConfig: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
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
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
  useAddToMachineConfigList: () => ({ mutate: () => {} }),
  useRemoveFromMachineConfigList: () => ({ mutate: () => {} }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-providers', () => ({
  useProviders: () => ({ data: { providers: [] }, isPending: false }),
  useTestProvider: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, isError: false }),
  useTaskConfig: () => ({ data: undefined, isPending: false }),
  useUpdateTaskConfig: () => ({ mutate: vi.fn(), isPending: false }),
  defaultBaseUrlForProvider: () => '',
  inferHarnessFromProviderType: () => 'claude-code-sdk',
  maybeInferHarnessFromProviderType: () => 'claude-code-sdk',
  providerSupportsHarness: () => true,
  supportedHarnessesForProviderInfo: () => [],
  parseHarnessId: (v: string) => v,
  parseProviderType: (v: string) => v,
  resolveReasoningModel: () => '',
  seedDraftFromProviderType: () => ({}),
  draftToProviderConfig: () => undefined,
  REASONING_LEVELS: ['low', 'default', 'high'],
  LOCAL_BACKEND_DEFAULT_BASE_URLS: {},
}));

mock.module('../../packages/myco/ui/src/hooks/use-provider-secrets', () => ({
  useProviderSecrets: () => ({ data: { secrets: {} } }),
  useSaveProviderSecret: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProviderSecret: () => ({ mutate: vi.fn(), isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-provider-config-draft', () => ({
  draftToNormalizedProviderConfig: () => ({}),
  emptyProviderDraft: () => ({ type: '', harness: '', model: '', localBackend: '', baseUrl: '', contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '' }),
  providerDraftFromSource: () => ({ type: '', harness: '', model: '', localBackend: '', baseUrl: '', contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '' }),
  providerDraftsEqual: () => true,
  normalizeSelectableModel: (v: string) => v,
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

mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => null,
}));

mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => null,
}));

mock.module('../../packages/myco/ui/src/components/config/PlanCaptureCard', () => ({
  PlanCaptureCard: () => <div data-testid="plan-capture-card" />,
}));

// scrollIntoView isn't implemented in jsdom.
if (typeof Element !== 'undefined' && !(Element.prototype as { scrollIntoView?: () => void }).scrollIntoView) {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
}

/* ---------- Tests ---------- */

function installJsdomGlobals() {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  vi.stubGlobal('localStorage', localStorageMock);
  vi.stubGlobal('location', window.location);
  const matchMedia = () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('matchMedia', matchMedia);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      beginPath: vi.fn(),
      rect: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    }),
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'toDataURL', {
    configurable: true,
    value: () => 'data:image/png;base64,',
  });
}

async function renderAppAt(path: string) {
  const { default: App } = await import('../../packages/myco/ui/src/App');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PowerProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </PowerProvider>
    </QueryClientProvider>,
  );
}

describe('legacy settings redirects', () => {
  beforeEach(() => {
    installJsdomGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards /g/:slug/settings to /settings and shows the Backup section', async () => {
    await renderAppAt('/g/work/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    });
    // The Backup group exists in the manifest with id "backup"; its section
    // should be rendered as an anchor target.
    const backupSection = document.querySelector('section#backup');
    expect(backupSection).not.toBeNull();
  });

  it('forwards /machine/settings to /settings and shows the Logging section', async () => {
    await renderAppAt('/machine/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    });
    const loggingSection = document.querySelector('section#logging');
    expect(loggingSection).not.toBeNull();
  });

  it('forwards /g/:g/p/:p/settings to /settings', async () => {
    await renderAppAt('/g/work/p/project-a-123abc/settings');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    });
  });
});
