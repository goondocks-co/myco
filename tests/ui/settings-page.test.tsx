// @vitest-environment jsdom

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
}));

// The Agent provider card depends on these hooks; stub them so the test
// doesn't hit the daemon. The card itself renders empty without a provider
// configured, which keeps the surface light.
mock.module('../../packages/myco/ui/src/hooks/use-providers', () => ({
  useProviders: () => ({ data: { providers: [] }, isPending: false }),
  useTestProvider: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, isError: false }),
  defaultBaseUrlForProvider: () => '',
  maybeInferHarnessFromProviderType: () => 'claude-code-sdk',
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
  deleteJson: vi.fn().mockResolvedValue({}),
  fetchMergedConfig: vi.fn().mockResolvedValue({}),
  fetchLocalConfig: vi.fn().mockResolvedValue({}),
  writeScopedConfig: vi.fn().mockResolvedValue({}),
  clearLocalConfigKeys: vi.fn().mockResolvedValue({}),
  ApiError: class ApiError extends Error {},
}));

// Stub heavy child renderers from the Agent card to keep the test light;
// the provider selector and reasoning profiles each pull in their own
// hooks and we don't exercise them here.
mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => null,
}));

// Notifications settings is its own large surface; stub it for this page test.
mock.module('../../packages/myco/ui/src/components/notifications/NotificationSettings', () => ({
  NotificationSettings: () => <div data-testid="notification-settings" />,
}));

// PlanCaptureCard reaches into a few internals; stub it to a marker for this test.
mock.module('../../packages/myco/ui/src/components/config/PlanCaptureCard', () => ({
  PlanCaptureCard: () => <div data-testid="plan-capture-card" />,
}));

// UpdateCard polls /update-status; BackupCard fetches /backups + manages
// preview/restore state. The unified-page tests don't exercise those flows —
// stub both to markers so the page layout tests stay focused.
mock.module('../../packages/myco/ui/src/components/operations/UpdateCard', () => ({
  UpdateCard: () => <div data-testid="update-card" />,
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
const { SETTINGS_GROUPS } = await import('../../packages/myco/ui/src/settings/manifest');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Unified Settings page', () => {
  beforeEach(() => {
    setFieldMock.mockReset();
    setFieldMock.mockResolvedValue(undefined);
    updateGroveMock.mockReset();
    updateGroveMock.mockResolvedValue(undefined);
    updateMachineMock.mockReset();
    updateMachineMock.mockResolvedValue(undefined);
    projectSelectionRef.current = {
      grove: { id: 'g1', slug: 'work', name: 'Work' },
      project: { id: 'p1', slug: 'p1', name: 'p1', root: '/tmp/p1', bindingId: 'b1' },
    };
  });

  it('renders all 12 groups in manifest order', () => {
    renderPage();
    // Each group renders its label as a heading inside the card.
    for (const group of SETTINGS_GROUPS) {
      expect(screen.getAllByText(group.label).length).toBeGreaterThan(0);
    }
    // 12 sections total in the document (anchors).
    const sections = document.querySelectorAll('section[id]');
    const ids = Array.from(sections).map((s) => s.id);
    expect(ids).toEqual(SETTINGS_GROUPS.map((g) => g.id));
  });

  it('scope filter narrows visible groups', () => {
    renderPage();
    // Click "Machine" — only groups with at least one machine-scoped field
    // (Logging, Update) should remain visible.
    fireEvent.click(screen.getByRole('button', { name: /^Machine/ }));

    // Visible: Logging, Update.
    const sections = Array.from(document.querySelectorAll('section[id]'));
    const visibleIds = sections
      .filter((s) => (s as HTMLElement).offsetParent !== null || true)
      .map((s) => s.id);
    expect(visibleIds).toContain('logging');
    expect(visibleIds).toContain('update');
    // Hidden: skills (project-only), team (grove-only).
    expect(visibleIds).not.toContain('skills');
    expect(visibleIds).not.toContain('team');
  });

  it('search filter narrows visible fields', async () => {
    renderPage();
    const searchInput = screen.getByPlaceholderText('Search settings...');
    fireEvent.change(searchInput, { target: { value: 'log level' } });

    // Wait for the 150ms debounce to settle.
    await waitFor(() => {
      const sections = Array.from(document.querySelectorAll('section[id]'));
      const visibleIds = sections.map((s) => s.id);
      expect(visibleIds).toContain('logging');
      expect(visibleIds).not.toContain('skills');
    }, { timeout: 500 });
  });

  it('TOC scrolls to a group on click', () => {
    renderPage();
    // The TOC button has the group label; clicking it should invoke
    // scrollIntoView on the matching section element.
    const target = document.getElementById('skills') as HTMLElement;
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    // The TOC button with the label "Skills" — there are multiple labels
    // (TOC entry + card heading), so we pick the button role.
    const buttons = screen.getAllByRole('button', { name: /Skills/ });
    const tocBtn = buttons.find((b) => b.getAttribute('aria-pressed') === null);
    expect(tocBtn).toBeTruthy();
    if (tocBtn) fireEvent.click(tocBtn);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('toggling a manifest-driven field calls writeField with correct scope', async () => {
    renderPage();
    // Maintenance.auto_optimize is a grove-scoped toggle. Find it by label
    // and click the switch — should call updateGrove with the nested patch.
    const label = screen.getByText('Auto-run PRAGMA optimize');
    const row = label.closest('div')?.parentElement?.parentElement; // grid row
    expect(row).toBeTruthy();
    const sw = row?.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(sw).toBeTruthy();
    if (sw) fireEvent.click(sw);

    await waitFor(() => {
      expect(updateGroveMock).toHaveBeenCalled();
    });
    // Patch shape should be { maintenance: { auto_optimize: <toggled> } }
    expect(updateGroveMock.mock.calls[0][0]).toEqual({
      maintenance: { auto_optimize: expect.any(Boolean) as unknown as boolean },
    });
  });

  it('Mixed scopes badge appears on Embedding (project + grove)', () => {
    renderPage();
    // The Embedding manifest spans project (provider/model/base_url) + grove
    // (run_in_deep_sleep). The page surfaces a "Mixed scopes" badge per group.
    const embedSection = document.getElementById('embedding');
    expect(embedSection).toBeTruthy();
    expect(embedSection?.textContent ?? '').toContain('Mixed scopes');
  });

  it('grove-scoped fields are disabled when no project is selected', () => {
    projectSelectionRef.current = null;
    renderPage();
    // Banner is shown when no project is active.
    expect(
      screen.getByText(/Select a project to edit Project and Grove settings/),
    ).toBeInTheDocument();
    // The grove-scoped maintenance.auto_optimize toggle should be disabled.
    const label = screen.getByText('Auto-run PRAGMA optimize');
    const row = label.closest('div')?.parentElement?.parentElement;
    const sw = row?.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(sw?.getAttribute('data-disabled') ?? sw?.disabled).toBeTruthy();
  });
});
