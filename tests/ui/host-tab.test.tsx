// @vitest-environment jsdom

/**
 * `HostTab` — the Team page's joined-host membership content: joined-hosts
 * list (leave/detach), attach control, drain health, and the host detail
 * slideout; plus `JoinHostForm` (exported from the same module, mounted by
 * the page's fork) and the `TeamPage` SHELL itself (E1 §5: fork-first when
 * unconnected, tabs + host-id targets when connected). Hooks are mocked so
 * these tests pin each COMPONENT's own job — form gating, the payload each
 * mutation is called with, which target a tab hands its panel, and what
 * renders for a given status snapshot — independent of
 * `use-host-membership.ts`'s own wire-mapping (covered by
 * `tests/ui/use-host-membership.test.tsx`).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import { ApiError } from '../../packages/myco/ui/src/lib/api';

// Radix Dialog (the attach/detach ConfirmDialog) reaches for MutationObserver /
// ResizeObserver in its focus scope; the bun+jsdom test env doesn't define
// them. Same stub the grove-modal dialog tests install.
class MutationObserverStub {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return []; }
}
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const _g = globalThis as unknown as Record<string, unknown>;
if (typeof _g.MutationObserver === 'undefined') _g.MutationObserver = MutationObserverStub;
if (typeof _g.ResizeObserver === 'undefined') _g.ResizeObserver = ResizeObserverStub;
if (typeof _g.NodeFilter === 'undefined' && typeof document !== 'undefined') {
  const win = document.defaultView as unknown as Record<string, unknown> | null;
  if (win && win.NodeFilter) _g.NodeFilter = win.NodeFilter;
}

const joinMutateAsync = vi.fn(async () => ({
  host_id: 'host_abc',
  host_reachable: true, created: true, notes: [],
}));
const leaveMutateAsync = vi.fn(async () => ({ removed: true, notes: [] }));
const attachMutateAsync = vi.fn(async () => ({
  project_id: 'proj_x', grove_id: 'grove_x', host_id: 'host_abc', host_label: 'Mac Studio',
  root: '/checkout', already_attached: false, notes: [],
}));
const detachMutateAsync = vi.fn(async () => ({ project_id: 'proj_x', detached_from_host_id: 'host_abc' }));
const abortMutateAsync = vi.fn(async () => ({ ok: true }));
const healthRefetchMock = vi.fn();

type ResidencyStatusFixture = {
  in_flight: boolean;
  direction?: 'attach' | 'detach';
  phase?: 'parking' | 'pushing' | 'pulling' | 'applying' | 'rehoming';
  rows_pending?: number | null;
  last_error?: string | null;
};

let statusFixture: { hosts: unknown[]; hint: unknown } = { hosts: [], hint: null };
let drainFixture: { hosts: unknown[] } = { hosts: [] };
let healthFixture: { hosts: unknown[] } = { hosts: [] };
let healthIsLoading = false;
// Residency status the mocked hook hands back regardless of the (projectId,
// enabled) args HostTab calls it with — `undefined` (default) is "no
// transition," so no progress line renders and no button is held off.
let residencyFixture: ResidencyStatusFixture | undefined;
const useResidencyStatusCalls: Array<{ projectId: string | undefined; enabled: boolean }> = [];
// Records every `enabled` argument the mocked hook is called with — lets
// the attach-panel tests confirm it reads the health query in cache-only
// mode (`enabled: false`, decision-ef693c71 D3) rather than probing itself.
const useHostMembershipHealthCalls: boolean[] = [];
let grovesFixture: { groves: Array<{ id: string; name: string; is_default: boolean }> } = { groves: [] };
// Records every `useGroves` call's options arg — lets the slideout tests
// below confirm it reads WITH includeArchived: true (an attach ref can name
// an archived local grove) while HostTab's own AttachProjectPanel picker
// call (`useGroves()`, no options — decision-ef693c71 D1) stays untouched.
const useGrovesCalls: Array<{ includeArchived?: boolean } | undefined> = [];

mock.module('../../packages/myco/ui/src/hooks/use-host-membership', () => ({
  useHostMembershipStatus: () => ({ data: statusFixture, isLoading: false }),
  useJoinHost: () => ({ mutateAsync: joinMutateAsync, isPending: false }),
  useLeaveHost: () => ({ mutateAsync: leaveMutateAsync, isPending: false }),
  useAttachProject: () => ({ mutateAsync: attachMutateAsync, isPending: false }),
  useDetachProject: () => ({ mutateAsync: detachMutateAsync, isPending: false }),
  useDrainHealth: () => ({ data: drainFixture, isLoading: false }),
  useHostMembershipHealth: (enabled: boolean) => {
    useHostMembershipHealthCalls.push(enabled);
    return { data: healthFixture, isLoading: healthIsLoading, isFetching: healthIsLoading, refetch: healthRefetchMock };
  },
  useResidencyStatus: (projectId: string | undefined, enabled: boolean) => {
    useResidencyStatusCalls.push({ projectId, enabled });
    // Model the real hook's gating: no data until the caller enables the watch
    // (i.e. until an attach/detach mutation has set the transition project id).
    return { data: enabled ? residencyFixture : undefined };
  },
  useResidencyAbort: () => ({ mutateAsync: abortMutateAsync, isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => null,
}));

// This machine's own serving state — the other half of the TeamPage shell's
// connected/unconnected decision (`undefined` = the read hasn't settled).
let serveFixture: unknown = { serving: false };

mock.module('../../packages/myco/ui/src/hooks/use-host-serve-status', () => ({
  useHostServeStatus: () => ({ data: serveFixture }),
}));

// The in-UI hosting control plane (HostATeamPanel + the serving card's
// actions). Inert here: no run is ever started, so every stage below the
// form stays unmounted and these tests keep their focus on the shell.
mock.module('../../packages/myco/ui/src/hooks/use-host-admin', () => ({
  useHostAdminEnable: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useHostAdminDisable: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMintJoinKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useHostAdminProgress: () => ({ data: null, isFetched: false }),
  useHostServePhase2: () => ({ data: null }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: (options?: { includeArchived?: boolean }) => {
    useGrovesCalls.push(options);
    return { data: grovesFixture, isLoading: false };
  },
}));

// ---------------------------------------------------------------------------
// The TeamPage shell's Settings tab mounts TeamSettingsPanel, which reuses
// AgentProviderCard/EmbeddingCard. Every field rendered through those forms
// in THIS file is bound to a team target, so useIsTeamConfigTarget is fixed
// true here (TeamConfigTargetProvider itself is stubbed to a passthrough —
// there's no real React context wiring once the whole module is mocked).
// The rest of this block mirrors settings-page.test.tsx's proven mock set
// for mounting the same reused forms.
// ---------------------------------------------------------------------------

const teamEffective: Record<string, unknown> = {
  agent: {
    provider: { type: '', model: '' },
    harness: '',
    scheduled_tasks_enabled: false,
    event_tasks_enabled: false,
  },
  embedding: { provider: 'ollama', model: 'bge-m3', base_url: '' },
};
let teamKeyHealth: 'ok' | 'missing_key' = 'missing_key';
// Captures the `target` prop each TeamConfigTargetProvider mount receives —
// lets the host-selection tests below assert which carrier a selector
// choice actually produced, without a real React context. The carrier names
// a DESTINATION HOST (PR #802), which is what makes a joined host with zero
// attached projects a configurable target.
type CapturedTarget = { carrier: { hostId: string } | null };
const teamTargetCalls: CapturedTarget[] = [];

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useIsTeamConfigTarget: () => true,
  useTeamConfigTargetOrNull: () => ({ carrier: null }),
  TeamConfigTargetProvider: ({ target, children }: { target: CapturedTarget; children: unknown }) => {
    teamTargetCalls.push(target);
    return children;
  },
  teamCarrierHeaders: () => ({}),
  useScopedConfig: () => ({
    effective: teamEffective,
    local: {},
    isLoading: false,
    isError: false,
    error: null,
    isLocalOverride: () => false,
    setField: vi.fn().mockResolvedValue(undefined),
    setFields: vi.fn().mockResolvedValue(undefined),
    resetField: vi.fn().mockResolvedValue(undefined),
    resetFields: vi.fn().mockResolvedValue(undefined),
    addToConfigList: vi.fn().mockResolvedValue(undefined),
    removeFromConfigList: vi.fn().mockResolvedValue(undefined),
    keyHealth: teamKeyHealth,
  }),
}));

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

mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => null,
}));

import { HostTab, JoinHostForm } from '../../packages/myco/ui/src/pages/Team/HostTab';
import { TeamPage } from '../../packages/myco/ui/src/pages/Team';

function renderHostTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={qc}>
        <HostTab />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

function renderJoinHostForm(props: { collapsed?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={qc}>
        <JoinHostForm {...props} />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

/** Surfaces the live query string so the tab/target URL contract can be
 *  asserted in both directions (URL → view, and click → URL). */
function LocationProbe() {
  return <span data-testid="location-search">{useLocation().search}</span>;
}

function renderTeamPage(initialEntry = '/team') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <TeamPage />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    </PowerProvider>,
  );
}

beforeEach(() => {
  statusFixture = { hosts: [], hint: null };
  serveFixture = { serving: false };
  // The page remembers its last host target across mounts — a leak here would
  // let one test pick another's target.
  localStorage.clear();
  drainFixture = { hosts: [] };
  healthFixture = { hosts: [] };
  healthIsLoading = false;
  grovesFixture = { groves: [] };
  residencyFixture = undefined;
  useHostMembershipHealthCalls.length = 0;
  useGrovesCalls.length = 0;
  useResidencyStatusCalls.length = 0;
  teamKeyHealth = 'missing_key';
  teamTargetCalls.length = 0;
  joinMutateAsync.mockClear();
  leaveMutateAsync.mockClear();
  attachMutateAsync.mockClear();
  detachMutateAsync.mockClear();
  abortMutateAsync.mockClear();
  healthRefetchMock.mockClear();
});

describe('JoinHostForm', () => {
  it('disables Join host until host id, key, and the host address are all filled', async () => {
    renderJoinHostForm();
    const submit = screen.getByRole('button', { name: /join host/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Host address'), { target: { value: 'https://h.tailnet.ts.net:8443' } });
    expect(submit).not.toBeDisabled();
  });

  it('submits exactly the three-field join payload and shows the success message', async () => {
    renderJoinHostForm();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Host address'), { target: { value: 'https://h.tailnet.ts.net:8443' } });
    fireEvent.click(screen.getByRole('button', { name: /join host/i }));

    await waitFor(() => expect(joinMutateAsync).toHaveBeenCalledWith({
      host_ref: 'host_abc', key: 'onetime', host_url: 'https://h.tailnet.ts.net:8443',
    }));
    await waitFor(() => expect(screen.getByTestId('host-join-success')).toBeInTheDocument());
  });

  it('clears the one-time key field after a successful join', async () => {
    renderJoinHostForm();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Host address'), { target: { value: 'https://h.tailnet.ts.net:8443' } });
    fireEvent.click(screen.getByRole('button', { name: /join host/i }));

    await waitFor(() => expect((screen.getByLabelText('One-time key') as HTMLInputElement).value).toBe(''));
  });

  it('renders mapped outcome copy for a coded refusal (protocol_mismatch) — never the CLI-voiced wire message', async () => {
    joinMutateAsync.mockImplementationOnce(async () => {
      // The real wire shape: the daemon API's error envelope carries the
      // orchestration's CLI-voiced message under a stable membership code.
      throw new ApiError(400, {
        error: {
          code: 'protocol_mismatch',
          message: 'The host rejected enrollment with a protocol-version mismatch (409). This member speaks Team-Host protocol v1; run `myco update` so both sides match, then retry.',
        },
      });
    });
    renderJoinHostForm();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Host address'), { target: { value: 'https://h.tailnet.ts.net:8443' } });
    fireEvent.click(screen.getByRole('button', { name: /join host/i }));

    await waitFor(() => expect(screen.getByTestId('host-join-error')).toHaveTextContent(/different Myco versions/));
    const rendered = screen.getByTestId('host-join-error').textContent ?? '';
    expect(rendered).not.toContain('myco update');
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain('409');
  });

  it('falls back to the raw daemon message for an uncoded failure', async () => {
    joinMutateAsync.mockImplementationOnce(async () => {
      throw new ApiError(400, { error: { code: 'join_failed', message: 'tailscaled socket did not appear (API 400)' } });
    });
    renderJoinHostForm();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Host address'), { target: { value: 'https://h.tailnet.ts.net:8443' } });
    fireEvent.click(screen.getByRole('button', { name: /join host/i }));

    await waitFor(() => expect(screen.getByTestId('host-join-error')).toHaveTextContent(/tailscaled socket did not appear/));
  });

  it('collapsed (the connected page\'s "add another" affordance) hides the form behind one control until asked', () => {
    renderJoinHostForm({ collapsed: true });

    expect(screen.queryByLabelText('Host id')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /join another team/i }));
    expect(screen.getByLabelText('Host id')).toBeInTheDocument();
  });
});

describe('Joined hosts list', () => {
  it('renders each host with its attach refs and a Detach control per project', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio',
        protocol_version: 1, created_at: '2026-01-01T00:00:00Z',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout' }],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.getByText('Mac Studio')).toBeInTheDocument();
    expect(screen.getByText('host_abc')).toBeInTheDocument();
    expect(screen.getByText('proj_x')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /detach proj_x/i })).toBeInTheDocument();
  });

  it('flags a host with NO address as re-join required, on the row itself', () => {
    // The row is where a user picks between hosts, so an unreachable one has to
    // be visible without opening the slideout. A missing address is not a
    // display gap — the host cannot be reached at all until a re-join.
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', host_url: null,
        protocol_version: 1, created_at: '2026-01-01T00:00:00Z',
        projects: [],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.getByTestId('host-row-rejoin')).toBeInTheDocument();
  });

  it('a host WITH an address carries no re-join flag', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', host_url: 'https://h.tailnet.ts.net:8443',
        protocol_version: 1, created_at: '2026-01-01T00:00:00Z',
        projects: [],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.queryByTestId('host-row-rejoin')).toBeNull();
  });

  it('renders a warning on a project ref whose mismatch flag is set (UX spec §2(c)) — never silent', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio',
        protocol_version: 1, created_at: '2026-01-01T00:00:00Z',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', mismatch: 'attach_grove_mismatch' }],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.getByTestId('project-ref-mismatch-proj_x')).toBeInTheDocument();
    // Copy doctrine (decision-6a2ccfac): user vocabulary only, never the
    // internal "Grove" mechanism name in a visible warning.
    expect(screen.getByTestId('project-ref-mismatch-proj_x').textContent ?? '').not.toMatch(/grove/i);
  });

  it('renders no warning on a project ref whose mismatch flag is null', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio',
        protocol_version: 1, created_at: '2026-01-01T00:00:00Z',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', mismatch: null }],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.queryByTestId('project-ref-mismatch-proj_x')).not.toBeInTheDocument();
  });

  it('Detach confirms first, then calls useDetachProject with the project root + id (no allow_no_pull on the happy path)', async () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio',
        protocol_version: 1, created_at: '',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout' }],
      }],
      hint: null,
    };
    renderHostTab();

    // The row Detach opens an honest confirmation; nothing mutates until the
    // dialog's own Disconnect is pressed.
    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    expect(detachMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/knowledge, as of this moment, comes back/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(detachMutateAsync).toHaveBeenCalledWith({ project_root: '/checkout', project_id: 'proj_x' }));
    expect(detachMutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('allow_no_pull');
  });

  it('Leave host opens an in-app confirmation naming the host, then calls useLeaveHost with the host id', async () => {
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    // The row control only OPENS the dialog — leaving is the dialog's own
    // confirm (same ConfirmDialog treatment as detach; no window.confirm).
    fireEvent.click(screen.getByRole('button', { name: /leave host/i }));
    expect(leaveMutateAsync).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Leave "Mac Studio"\?/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave host' }));

    await waitFor(() => expect(leaveMutateAsync).toHaveBeenCalledWith('host_abc'));
  });

  it('Leave host does nothing when the confirmation is dismissed', async () => {
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /leave host/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(leaveMutateAsync).not.toHaveBeenCalled();
  });
});

describe('AttachProjectPanel', () => {
  it('does not render when no hosts are joined', () => {
    statusFixture = { hosts: [], hint: null };
    renderHostTab();
    expect(screen.queryByText('Route a project through a Team Host')).not.toBeInTheDocument();
  });

  it('takes an operator-typed project path (never a picker of already-locally-registered projects), and submits project_root/host_id — no grove id (the daemon sources it from the host record)', async () => {
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    // Attach takes a typed checkout path (like `myco attach <project>`), not a
    // picker built from /api/groves — a project with local history is migrated
    // to the host on attach (Phase F), so this is a path field, not a list.
    const submit = screen.getByRole('button', { name: /attach project/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/fresh' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_abc' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    // Attach now confirms first (the move is honest about what happens).
    expect(attachMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/that history moves to the team host/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect to team' }));

    await waitFor(() => expect(attachMutateAsync).toHaveBeenCalledWith({
      project_root: '/checkout/fresh', host_id: 'host_abc',
    }));
    await waitFor(() => expect(screen.getByTestId('host-attach-success')).toBeInTheDocument());
  });

  it('renders mapped outcome copy for project_registered_locally — no "task A2", no CLI syntax', async () => {
    attachMutateAsync.mockImplementationOnce(async () => {
      throw new ApiError(400, {
        error: {
          code: 'project_registered_locally',
          message: 'Cannot attach proj_x: it still has local Grove data (Grove grove_y). Adopting existing '
            + 'local history into a team host requires the residency-transition migration, which is not yet '
            + 'available (task A2). This command attaches a project going forward only — detach/migrate the '
            + 'project off its local Grove first.',
        },
      });
    });
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/used' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_abc' } });
    fireEvent.click(screen.getByRole('button', { name: /attach project/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect to team' }));

    // The coded refusal surfaces inside the still-open confirm dialog.
    await waitFor(() => expect(screen.getByTestId('confirm-dialog-error')).toHaveTextContent(/already has local Myco data/));
    const rendered = screen.getByTestId('confirm-dialog-error').textContent ?? '';
    expect(rendered).not.toContain('task A2');
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain('myco ');
  });
});

describe('DrainHealthPanel', () => {
  it('renders pending/failing counters per host per drain, with units per drain kind — including the residency drain', () => {
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    drainFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio',
        drains: {
          transcript: { pending_entries: 2, pending_bytes: 18234, failing_entries: 1, host_unreachable_entries: 1 },
          plan: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
          event_replay: { pending_entries: 3, pending_records: 9, failing_entries: 0, host_unreachable_entries: 0 },
          residency: { pending_entries: 5, pending_records: 12, failing_entries: 0, host_unreachable_entries: 0 },
        },
      }],
    };
    renderHostTab();

    expect(screen.getByText(/2 pending \(18,234 bytes\) · 1 failing/)).toBeInTheDocument();
    expect(screen.getByText(/3 pending \(9 records\)/)).toBeInTheDocument();
    // The residency drain renders with the same treatment as the other three.
    expect(screen.getByText('Residency')).toBeInTheDocument();
    expect(screen.getByText(/5 pending \(12 records\)/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Residency round trip (Phase F, T5) — honest attach/detach confirmations, the
// in-flight progress line, cancel-move, and the pull-unavailable fallback.
// ---------------------------------------------------------------------------

describe('Residency round trip', () => {
  const attachedHost = {
    host_id: 'host_abc', label: 'Mac Studio',
    protocol_version: 3, created_at: '',
    projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', mismatch: null }],
  };

  it('attach confirm sets the honest expectation and is cancelable — Cancel moves nothing', () => {
    statusFixture = { hosts: [attachedHost], hint: null };
    renderHostTab();

    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/fresh' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_abc' } });
    fireEvent.click(screen.getByRole('button', { name: /attach project/i }));

    // Assert on a phrase unique to the confirm dialog — the card's own intro
    // paragraph now shares the "local backup" wording with it by design.
    expect(screen.getByText(/earlier sessions carry their knowledge summaries/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(attachMutateAsync).not.toHaveBeenCalled();
  });

  it('detach falls back to allow_no_pull once the member accepts "disconnect anyway"', async () => {
    detachMutateAsync.mockImplementationOnce(async () => {
      throw new ApiError(400, { error: { code: 'residency_pull_unavailable', message: 'host predates residency pull' } });
    });
    statusFixture = { hosts: [attachedHost], hint: null };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    // The refusal keeps the dialog open and offers the explicit fallback.
    await waitFor(() => expect(screen.getByText(/Disconnect anyway without bringing data back\?/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect anyway' }));

    await waitFor(() => expect(detachMutateAsync).toHaveBeenLastCalledWith({
      project_root: '/checkout', project_id: 'proj_x', allow_no_pull: true,
    }));
  });

  it('shows a direction-aware progress line with phase + pending count once a transition is watched', async () => {
    residencyFixture = { in_flight: true, direction: 'detach', phase: 'pulling', rows_pending: 42 };
    statusFixture = { hosts: [attachedHost], hint: null };
    renderHostTab();

    // No progress until a transition is actually watched (post-mutation).
    expect(screen.queryByTestId('residency-progress-proj_x')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    const progress = await screen.findByTestId('residency-progress-proj_x');
    expect(within(progress).getByText(/Bringing your data back/)).toBeInTheDocument();
    expect(within(progress).getByText(/retrieving/)).toBeInTheDocument();
    expect(within(progress).getByText(/42 items left/)).toBeInTheDocument();
    expect(within(progress).getByRole('button', { name: /cancel move/i })).toBeInTheDocument();
  });

  it('Cancel move confirms in-app, then calls residency-abort for the project', async () => {
    residencyFixture = { in_flight: true, direction: 'attach', phase: 'pushing', rows_pending: 3 };
    statusFixture = { hosts: [attachedHost], hint: null };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const progress = await screen.findByTestId('residency-progress-proj_x');
    fireEvent.click(within(progress).getByRole('button', { name: /cancel move/i }));

    // The progress line's Cancel only opens the dialog; the abort is the
    // dialog's own confirm (no window.confirm anywhere in this flow).
    expect(abortMutateAsync).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel move' }));

    await waitFor(() => expect(abortMutateAsync).toHaveBeenCalledWith({ project_id: 'proj_x' }));
  });

  it('a too-late cancel on an attach shows the direction-appropriate recovery (disconnect to get data back)', async () => {
    abortMutateAsync.mockImplementationOnce(async () => {
      throw new ApiError(400, { error: { code: 'residency_abort_too_late', message: 'phase rehoming' } });
    });
    residencyFixture = { in_flight: true, direction: 'attach', phase: 'pushing', rows_pending: 1 };
    statusFixture = { hosts: [attachedHost], hint: null };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const progress = await screen.findByTestId('residency-progress-proj_x');
    fireEvent.click(within(progress).getByRole('button', { name: /cancel move/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel move' }));

    await waitFor(() => expect(within(progress).getByText(/disconnect the project/)).toBeInTheDocument());
  });

  it('surfaces the stalled warning when the last attempt erred, without leaking the raw error into the visible line', async () => {
    residencyFixture = { in_flight: true, direction: 'attach', phase: 'pushing', rows_pending: null, last_error: 'ECONNRESET at drain step 3' };
    statusFixture = { hosts: [attachedHost], hint: null };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    const progress = await screen.findByTestId('residency-progress-proj_x');
    expect(within(progress).getByText(/ran into a problem and will keep retrying/)).toBeInTheDocument();
    expect(progress.textContent ?? '').not.toContain('ECONNRESET');
  });

  it('holds off other projects\' Detach while a transition is in flight (belt and suspenders with the backend)', async () => {
    residencyFixture = { in_flight: true, direction: 'detach', phase: 'pulling' };
    statusFixture = {
      hosts: [{
        ...attachedHost,
        projects: [
          { grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', mismatch: null },
          { grove_id: 'grove_y', project_id: 'proj_y', root: '/checkout-y', mismatch: null },
        ],
      }],
      hint: null,
    };
    renderHostTab();

    // Both enabled before any transition starts.
    expect(screen.getByRole('button', { name: /detach proj_y/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    // Once proj_x is transitioning, proj_y's Detach is held off too.
    await waitFor(() => expect(screen.getByRole('button', { name: /detach proj_y/i })).toBeDisabled());
  });

  it('keeps a standalone progress line in the host card after a detach drops the ref mid-transition (no Cancel past the flip)', async () => {
    residencyFixture = { in_flight: true, direction: 'detach', phase: 'pulling', rows_pending: null };
    statusFixture = { hosts: [attachedHost], hint: null };

    // Own the tree + client so a rerender preserves HostTab's transition state
    // across the fixture change (the ref-drop can't be driven from the outside).
    // A FRESH element each time — passing the same object makes React bail out
    // of the rerender and the mocked hooks never re-read the new fixtures.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const makeTree = () => (
      <PowerProvider>
        <QueryClientProvider client={qc}>
          <HostTab />
        </QueryClientProvider>
      </PowerProvider>
    );
    const { rerender } = render(makeTree());

    // Start the detach: the row is present with an in-row, cancelable progress.
    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const inRow = await screen.findByTestId('residency-progress-proj_x');
    expect(within(inRow).getByRole('button', { name: /cancel move/i })).toBeInTheDocument();

    // The pulling→applying flip: T4 drops the member ref while the transition
    // keeps restoring. Ref gone from the host, phase now applying.
    statusFixture = { hosts: [{ ...attachedHost, projects: [] }], hint: null };
    residencyFixture = { in_flight: true, direction: 'detach', phase: 'applying', rows_pending: null };
    rerender(makeTree());

    // Progress persists standalone in the same host card, now without Cancel.
    const standalone = screen.getByTestId('residency-progress-proj_x');
    expect(within(standalone).getByText(/Bringing your data back/)).toBeInTheDocument();
    expect(within(standalone).getByText(/restoring/)).toBeInTheDocument();
    expect(within(standalone).queryByRole('button', { name: /cancel move/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The TeamPage SHELL (E1 §5) — fork-first when unconnected, tabs + host-id
// targets when connected. `HostTab` above is only what Tab 1 renders.
// ---------------------------------------------------------------------------

const SERVING_FIXTURE = {
  serving: true,
  served_grove_id: 'grove_served', served_grove_name: 'Team Storage',
  host_id: 'host_self', label: 'This Box',
  hosted_project_count: 0,
  external_mcp: { enabled: false, port: 0, bound: null, token_present: false },
  bearer_present: true,
  health: { designation: 'ok', backup: 'ok', key: 'ok', mcp_coherence: 'ok' },
};

/** A joined host with ZERO attached projects — the case the old
 *  attached-project-ref carrier could not target at all. */
const REFLESS_HOST = {
  host_id: 'host_abc', label: 'Mac Studio',
  protocol_version: 1, created_at: '', projects: [],
};

describe('Team page shell — the fork', () => {
  it('renders neither branch until BOTH the membership and serving reads have settled', () => {
    serveFixture = undefined;
    renderTeamPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByTestId('team-fork')).not.toBeInTheDocument();
    expect(screen.queryByTestId('team-connected')).not.toBeInTheDocument();
  });

  it('unconnected (no joined hosts, not serving) renders the fork and NOTHING else', () => {
    statusFixture = { hosts: [], hint: null };
    serveFixture = { serving: false };
    renderTeamPage();

    const fork = screen.getByTestId('team-fork');
    expect(within(fork).getByRole('button', { name: 'Host a team' })).toBeInTheDocument();
    expect(within(fork).getByRole('button', { name: 'Join host' })).toBeInTheDocument();
    expect(within(fork).getByText('Join a Team Host')).toBeInTheDocument();

    // No tabs, and — the whole point of the fork — no team-config surface:
    // its first fetch used to 404 `not_serving` and render an error banner as
    // the page's DEFAULT state.
    expect(screen.queryByTestId('team-connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Team settings')).not.toBeInTheDocument();
    expect(teamTargetCalls).toEqual([]);
  });

  it('serving alone (no joined hosts) counts as connected — the host operator gets the tabs', () => {
    statusFixture = { hosts: [], hint: null };
    serveFixture = SERVING_FIXTURE;
    renderTeamPage();

    expect(screen.getByTestId('team-connected')).toBeInTheDocument();
    expect(screen.queryByTestId('team-fork')).not.toBeInTheDocument();
  });
});

describe('Team page shell — tabs', () => {
  it('offers Team / External access / Settings, with the joined-host content under Team and no target selector', () => {
    statusFixture = { hosts: [REFLESS_HOST], hint: null };
    renderTeamPage();

    // `external_mcp_supported` absent (older daemon) reads as capable.
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'External access' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();

    expect(screen.getByText('1 host')).toBeInTheDocument();
    expect(screen.getByText('Mac Studio')).toBeInTheDocument();
    // The machine-scoped tab has nothing to target — no selector, no panel.
    expect(screen.queryByTestId('team-target-select')).not.toBeInTheDocument();
    expect(teamTargetCalls).toEqual([]);
  });

  it('hides the External access tab when the daemon reports external_mcp_supported: false', () => {
    statusFixture = { hosts: [REFLESS_HOST], hint: null, external_mcp_supported: false };
    renderTeamPage();

    // A live toggle that can only 502 on this platform is a lying switch.
    expect(screen.queryByRole('tab', { name: 'External access' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('falls back to the Team tab when the URL names a tab this daemon does not have', () => {
    statusFixture = { hosts: [REFLESS_HOST], hint: null, external_mcp_supported: false };
    renderTeamPage('/team?tab=external');

    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('1 host')).toBeInTheDocument();
  });

  it('opens the tab named in ?tab= and writes the tab back to the URL on a click', async () => {
    statusFixture = { hosts: [REFLESS_HOST], hint: null };
    renderTeamPage('/team?tab=settings');

    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Team settings')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('tab=team'));
    expect(screen.queryByText('Team settings')).not.toBeInTheDocument();
  });
});

describe('Team page shell — host targets', () => {
  it('targets a joined host with ZERO attached projects — by host id, never dropped from the selector', () => {
    statusFixture = { hosts: [REFLESS_HOST], hint: null };
    renderTeamPage('/team?tab=settings');

    const select = screen.getByTestId('team-target-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Mac Studio (host_abc)']);
    // The carrier is the HOST — a refless host used to have no ref to ride on,
    // so the write silently landed on this member's own daemon instead.
    expect(teamTargetCalls.at(-1)).toEqual({ carrier: { hostId: 'host_abc' } });
  });

  it('offers "This machine" FIRST and only while this machine is serving', () => {
    statusFixture = { hosts: [REFLESS_HOST], hint: null };
    serveFixture = SERVING_FIXTURE;
    renderTeamPage('/team?tab=settings');

    const select = screen.getByTestId('team-target-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['This machine', 'Mac Studio (host_abc)']);
    expect(select.value).toBe('self');
    // "This machine" carries no host id — the daemon resolves its own served
    // grove server-side.
    expect(teamTargetCalls.at(-1)).toEqual({ carrier: null });
  });

  it('selecting another host re-targets the settings panel and records the choice in the URL', async () => {
    statusFixture = {
      hosts: [
        REFLESS_HOST,
        { host_id: 'host_def', label: 'Linux Box', protocol_version: 1, created_at: '', projects: [] },
      ],
      hint: null,
    };
    renderTeamPage('/team?tab=settings');

    expect(teamTargetCalls.at(-1)).toEqual({ carrier: { hostId: 'host_abc' } });

    fireEvent.change(screen.getByTestId('team-target-select'), { target: { value: 'host_def' } });

    await waitFor(() => expect(teamTargetCalls.at(-1)).toEqual({ carrier: { hostId: 'host_def' } }));
    expect(screen.getByTestId('location-search')).toHaveTextContent('team=host_def');
  });

  it('honors the host named in ?team= on first render — the view is linkable', () => {
    statusFixture = {
      hosts: [
        REFLESS_HOST,
        { host_id: 'host_def', label: 'Linux Box', protocol_version: 1, created_at: '', projects: [] },
      ],
      hint: null,
    };
    renderTeamPage('/team?tab=settings&team=host_def');

    expect((screen.getByTestId('team-target-select') as HTMLSelectElement).value).toBe('host_def');
    expect(teamTargetCalls.at(-1)).toEqual({ carrier: { hostId: 'host_def' } });
  });

  it('mounts the settings panel for the selected host, keyHealth and all', () => {
    teamKeyHealth = 'ok';
    statusFixture = { hosts: [REFLESS_HOST], hint: null };
    renderTeamPage('/team?tab=settings');

    expect(screen.getByText('Team settings')).toBeInTheDocument();
    expect(screen.getByText(/a team key is configured/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Host detail slideout (E-4 W1 Task T5) — page-wide selected host, additive:
// the host list, DrainHealthPanel, and AttachProjectPanel below still render
// every host exactly as before; selecting one only opens the detail surface.
// ---------------------------------------------------------------------------

const hostA = {
  host_id: 'host_a', label: 'Mac Studio',
  protocol_version: 1, created_at: '2026-01-01T00:00:00Z', projects: [],
};
const hostB = {
  host_id: 'host_b', label: 'Linux Box',
  protocol_version: 1, created_at: '2026-02-02T00:00:00Z', projects: [],
};

describe('Host detail slideout — selection', () => {
  it('is closed by default; selecting a host opens it with that host\'s identity', () => {
    statusFixture = { hosts: [hostA, hostB], hint: null };
    renderHostTab();

    expect(screen.queryByTestId('host-detail-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view linux box details/i }));

    const panel = screen.getByTestId('host-detail-panel');
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByText('Linux Box')).toBeInTheDocument();
  });

  it('closing the slideout clears the selection', () => {
    statusFixture = { hosts: [hostA], hint: null };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));
    expect(screen.getByTestId('host-detail-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('host-detail-close'));
    expect(screen.queryByTestId('host-detail-panel')).not.toBeInTheDocument();
  });

  it('selection does not filter the host list — every host keeps rendering', () => {
    statusFixture = { hosts: [hostA, hostB], hint: null };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    // Linux Box is unselected but still listed (unambiguous: the slideout
    // shows Mac Studio's identity, not Linux Box's).
    expect(screen.getByText('Linux Box')).toBeInTheDocument();
  });
});

describe('Host detail slideout — reachability', () => {
  function openSlideout(host: typeof hostA = hostA) {
    statusFixture = { hosts: [host], hint: null };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`view ${host.label} details`, 'i') }));
  }

  it('renders "Checking…" while the health query is loading', () => {
    healthIsLoading = true;
    openSlideout();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('renders Reachable for reachable: true', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: true, checked_at: '', protocol_skew: 'none' }] };
    openSlideout();
    expect(screen.getByText('Reachable')).toBeInTheDocument();
  });

  it('renders Unreachable for reachable: false', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: false, checked_at: '', protocol_skew: 'none' }] };
    openSlideout();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
  });

  it('renders "Not confirmed reachable" for reachable: null (no proxy port on record — never a false negative)', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: null, checked_at: '', protocol_skew: 'none' }] };
    openSlideout();
    expect(screen.getByText('Not confirmed reachable')).toBeInTheDocument();
  });

  it('renders no skew note when protocol_skew is none', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: true, checked_at: '', protocol_skew: 'none' }] };
    openSlideout();
    expect(screen.queryByTestId('host-detail-skew-note')).not.toBeInTheDocument();
  });

  it('renders the host_older skew note naming the HOST as needing the update', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: true, checked_at: '', protocol_skew: 'host_older' }] };
    openSlideout();
    expect(screen.getByTestId('host-detail-skew-note')).toHaveTextContent(/the host needs a myco update/i);
  });

  it('renders the host_newer skew note naming THIS machine as needing the update', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: true, checked_at: '', protocol_skew: 'host_newer' }] };
    openSlideout();
    expect(screen.getByTestId('host-detail-skew-note')).toHaveTextContent(/update this machine/i);
  });

  it('"Check now" calls the health query\'s refetch', () => {
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: true, checked_at: '', protocol_skew: 'none' }] };
    openSlideout();
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    expect(healthRefetchMock).toHaveBeenCalled();
  });
});

describe('Host detail slideout — per-host drain breakdown', () => {
  it('filters the shared useDrainHealth() data to the selected host — no second fetch', () => {
    statusFixture = { hosts: [hostA], hint: null };
    drainFixture = {
      hosts: [{
        host_id: 'host_a', label: 'Mac Studio',
        drains: {
          transcript: { pending_entries: 2, pending_bytes: 500, failing_entries: 0, host_unreachable_entries: 0 },
          plan: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
          event_replay: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
        },
      }],
    };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    expect(within(screen.getByTestId('host-detail-panel')).getByText(/2 pending \(500 bytes\)/)).toBeInTheDocument();
  });
});

describe('Host detail slideout — attached projects', () => {
  it('shows the empty-state line when the host has no attached projects', () => {
    statusFixture = { hosts: [hostA], hint: null };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    expect(screen.getByText('No projects attached to this host yet.')).toBeInTheDocument();
  });

  it('resolves local_grove_id to the matching local Grove\'s display name', () => {
    statusFixture = {
      hosts: [{
        ...hostA,
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', local_grove_id: 'grove_local_1', mismatch: null }],
      }],
      hint: null,
    };
    grovesFixture = { groves: [{ id: 'grove_local_1', name: 'Personal', is_default: true }] };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    expect(screen.getByText(/Shows under: Personal/)).toBeInTheDocument();
  });

  it('resolves an ARCHIVED local Grove\'s display name (E-4 W2 Task 7, item d) — includeArchived: true', () => {
    statusFixture = {
      hosts: [{
        ...hostA,
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', local_grove_id: 'grove_archived_1', mismatch: null }],
      }],
      hint: null,
    };
    // useGroves() defaults to excluding archived Groves — the mock here
    // returns the fixture regardless of the option, so this row's presence
    // only proves the render path; the includeArchived: true assertion below
    // is what actually pins the fix (before it, the real hook would never
    // have returned this archived Grove and the name lookup would miss).
    grovesFixture = { groves: [{ id: 'grove_archived_1', name: 'Old Client Work', is_default: false }] };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    expect(screen.getByText(/Shows under: Old Client Work/)).toBeInTheDocument();
    expect(useGrovesCalls).toContainEqual({ includeArchived: true });
    // HostTab's own AttachProjectPanel local-Grove PICKER call (decision-
    // ef693c71 D1) must stay untouched — non-archived, no options.
    expect(useGrovesCalls).toContainEqual(undefined);
  });

  it('falls back to the raw local_grove_id when it names no loaded Grove', () => {
    statusFixture = {
      hosts: [{
        ...hostA,
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', local_grove_id: 'grove_ghost', mismatch: null }],
      }],
      hint: null,
    };
    grovesFixture = { groves: [] };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    expect(screen.getByText(/Shows under: grove_ghost/)).toBeInTheDocument();
  });
});

describe('Host detail slideout — leave flow', () => {
  it('Leave host is reachable from the slideout and runs the same confirm-then-leave flow', async () => {
    statusFixture = { hosts: [hostA], hint: null };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    const panel = screen.getByTestId('host-detail-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /leave host/i }));
    expect(leaveMutateAsync).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave host' }));

    await waitFor(() => expect(leaveMutateAsync).toHaveBeenCalledWith('host_a'));
  });
});

describe('AttachProjectPanel — local Grove picker (Task T5, decision-ef693c71 D1)', () => {
  it('does not render the "Show under" picker when no local Groves are loaded', () => {
    statusFixture = { hosts: [hostA], hint: null };
    grovesFixture = { groves: [] };
    renderHostTab();

    expect(screen.queryByLabelText('Show under')).not.toBeInTheDocument();
  });

  it('defaults the picker to the default Grove and sends its id as local_grove_id', async () => {
    statusFixture = { hosts: [hostA], hint: null };
    grovesFixture = {
      groves: [
        { id: 'grove_a', name: 'Work', is_default: false },
        { id: 'grove_b', name: 'Personal', is_default: true },
      ],
    };
    renderHostTab();

    const groveSelect = screen.getByLabelText('Show under') as HTMLSelectElement;
    expect(groveSelect.value).toBe('grove_b');

    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/fresh' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_a' } });
    fireEvent.click(screen.getByRole('button', { name: /attach project/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect to team' }));

    await waitFor(() => expect(attachMutateAsync).toHaveBeenCalledWith({
      project_root: '/checkout/fresh', host_id: 'host_a', local_grove_id: 'grove_b',
    }));
  });

  it('sends the operator-chosen Grove when the picker is changed away from the default', async () => {
    statusFixture = { hosts: [hostA], hint: null };
    grovesFixture = {
      groves: [
        { id: 'grove_a', name: 'Work', is_default: false },
        { id: 'grove_b', name: 'Personal', is_default: true },
      ],
    };
    renderHostTab();

    fireEvent.change(screen.getByLabelText('Show under'), { target: { value: 'grove_a' } });
    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/fresh' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_a' } });
    fireEvent.click(screen.getByRole('button', { name: /attach project/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect to team' }));

    await waitFor(() => expect(attachMutateAsync).toHaveBeenCalledWith({
      project_root: '/checkout/fresh', host_id: 'host_a', local_grove_id: 'grove_a',
    }));
  });
});

describe('AttachProjectPanel — host select reachability hint (Task T5)', () => {
  it('shows no hint when no health data is cached for that host', () => {
    statusFixture = { hosts: [hostA], hint: null };
    healthFixture = { hosts: [] };
    renderHostTab();

    const select = screen.getByLabelText('Host') as HTMLSelectElement;
    const opt = Array.from(select.options).find((o) => o.value === 'host_a');
    expect(opt?.textContent).toBe('Mac Studio (host_a)');
  });

  it('annotates the option from cached health data, and reads the health query in cache-only mode', () => {
    statusFixture = { hosts: [hostA], hint: null };
    healthFixture = { hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: false, checked_at: '', protocol_skew: 'none' }] };
    renderHostTab();

    const select = screen.getByLabelText('Host') as HTMLSelectElement;
    const opt = Array.from(select.options).find((o) => o.value === 'host_a');
    expect(opt?.textContent).toBe('Mac Studio (host_a) — unreachable');
    // The attach panel itself never probes — it only reads whatever the
    // slideout's own query already cached (`enabled: false` here).
    expect(useHostMembershipHealthCalls).toContain(false);
  });
});
