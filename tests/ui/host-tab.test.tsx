// @vitest-environment jsdom

/**
 * `HostTab` (consolidation Task D-2) — the Team page's primary Team Host
 * membership UI: join form, joined-hosts list (leave/detach), attach
 * control, and the drain-health panel. Hooks are mocked so these tests pin
 * the COMPONENT's own job — form gating, the payload each mutation is
 * called with, and what renders for a given status snapshot — independent
 * of `use-host-membership.ts`'s own wire-mapping (covered by
 * `tests/ui/use-host-membership.test.tsx`).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import { ApiError } from '../../packages/myco/ui/src/lib/api';

const joinMutateAsync = vi.fn(async () => ({
  host_id: 'host_abc', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
  member_overlay_ip: '100.64.0.5', host_reachable: true, created: true, notes: [],
}));
const leaveMutateAsync = vi.fn(async () => ({ removed: true, tailscaled_removed: true, notes: [] }));
const attachMutateAsync = vi.fn(async () => ({
  project_id: 'proj_x', grove_id: 'grove_x', host_id: 'host_abc', host_label: 'Mac Studio',
  root: '/checkout', already_attached: false, notes: [],
}));
const detachMutateAsync = vi.fn(async () => ({ project_id: 'proj_x', detached_from_host_id: 'host_abc' }));
const healthRefetchMock = vi.fn();

let statusFixture: { hosts: unknown[]; hint: unknown } = { hosts: [], hint: null };
let drainFixture: { hosts: unknown[] } = { hosts: [] };
let healthFixture: { hosts: unknown[] } = { hosts: [] };
let healthIsLoading = false;
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
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => null,
}));

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: (options?: { includeArchived?: boolean }) => {
    useGrovesCalls.push(options);
    return { data: grovesFixture, isLoading: false };
  },
}));

// ---------------------------------------------------------------------------
// HostTab now always mounts TeamSettingsPanel (Task 9), which reuses
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
// choice actually produced, without a real React context.
const teamTargetCalls: Array<{ carrier: { groveId: string; projectId: string } | null }> = [];

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useIsTeamConfigTarget: () => true,
  useTeamConfigTargetOrNull: () => ({ carrier: null }),
  TeamConfigTargetProvider: ({ target, children }: { target: { carrier: { groveId: string; projectId: string } | null }; children: unknown }) => {
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

import { HostTab } from '../../packages/myco/ui/src/pages/Team/HostTab';

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

beforeEach(() => {
  statusFixture = { hosts: [], hint: null };
  drainFixture = { hosts: [] };
  healthFixture = { hosts: [] };
  healthIsLoading = false;
  grovesFixture = { groves: [] };
  useHostMembershipHealthCalls.length = 0;
  useGrovesCalls.length = 0;
  teamKeyHealth = 'missing_key';
  teamTargetCalls.length = 0;
  joinMutateAsync.mockClear();
  leaveMutateAsync.mockClear();
  attachMutateAsync.mockClear();
  detachMutateAsync.mockClear();
  healthRefetchMock.mockClear();
});

describe('JoinHostForm', () => {
  it('disables Join host until host id, key, server URL, and overlay address are all filled', async () => {
    renderHostTab();
    const submit = screen.getByRole('button', { name: /join host/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Overlay address'), { target: { value: '100.64.0.1:7433' } });
    expect(submit).not.toBeDisabled();
  });

  it('submits exactly the four-field join payload and shows the success message', async () => {
    renderHostTab();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.change(screen.getByLabelText('Overlay address'), { target: { value: '100.64.0.1:7433' } });
    fireEvent.click(screen.getByRole('button', { name: /join host/i }));

    await waitFor(() => expect(joinMutateAsync).toHaveBeenCalledWith({
      host_ref: 'host_abc', key: 'onetime', server_url: 'https://h:8080', overlay_address: '100.64.0.1:7433',
    }));
    await waitFor(() => expect(screen.getByTestId('host-join-success')).toBeInTheDocument());
  });

  it('clears the one-time key field after a successful join', async () => {
    renderHostTab();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.change(screen.getByLabelText('Overlay address'), { target: { value: '100.64.0.1:7433' } });
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
    renderHostTab();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.change(screen.getByLabelText('Overlay address'), { target: { value: '100.64.0.1:7433' } });
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
    renderHostTab();
    fireEvent.change(screen.getByLabelText('Host id'), { target: { value: 'host_abc' } });
    fireEvent.change(screen.getByLabelText('One-time key'), { target: { value: 'onetime' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.change(screen.getByLabelText('Overlay address'), { target: { value: '100.64.0.1:7433' } });
    fireEvent.click(screen.getByRole('button', { name: /join host/i }));

    await waitFor(() => expect(screen.getByTestId('host-join-error')).toHaveTextContent(/tailscaled socket did not appear/));
  });
});

describe('Joined hosts list', () => {
  it('renders each host with its attach refs and a Detach control per project', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
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

  it('renders a warning on a project ref whose mismatch flag is set (UX spec §2(c)) — never silent', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
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
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
        protocol_version: 1, created_at: '2026-01-01T00:00:00Z',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', mismatch: null }],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.queryByTestId('project-ref-mismatch-proj_x')).not.toBeInTheDocument();
  });

  it('Detach calls useDetachProject with the project root + id', async () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1,
        protocol_version: 1, created_at: '',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout' }],
      }],
      hint: null,
    };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /detach proj_x/i }));
    await waitFor(() => expect(detachMutateAsync).toHaveBeenCalledWith({ project_root: '/checkout', project_id: 'proj_x' }));
  });

  it('Leave host confirms, then calls useLeaveHost with the host id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1, protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /leave host/i }));
    await waitFor(() => expect(leaveMutateAsync).toHaveBeenCalledWith('host_abc'));
    confirmSpy.mockRestore();
  });

  it('Leave host does nothing when the confirm dialog is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1, protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    fireEvent.click(screen.getByRole('button', { name: /leave host/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(leaveMutateAsync).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
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
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1, protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    // Attach is going-forward only (attach-command.ts): any project already
    // visible via /api/groves has local Grove state and would be refused, so
    // the field is a free-text path, not a picker built from that list.
    const submit = screen.getByRole('button', { name: /attach project/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/fresh' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_abc' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

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
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1, protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    renderHostTab();

    fireEvent.change(screen.getByLabelText('Project path'), { target: { value: '/checkout/used' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host_abc' } });
    fireEvent.click(screen.getByRole('button', { name: /attach project/i }));

    await waitFor(() => expect(screen.getByTestId('host-attach-error')).toHaveTextContent(/already has local Myco data/));
    const rendered = screen.getByTestId('host-attach-error').textContent ?? '';
    expect(rendered).not.toContain('task A2');
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain('myco ');
  });
});

describe('DrainHealthPanel', () => {
  it('renders pending/failing counters per host per drain, with units per drain kind', () => {
    statusFixture = {
      hosts: [{ host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1, protocol_version: 1, created_at: '', projects: [] }],
      hint: null,
    };
    drainFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio',
        drains: {
          transcript: { pending_entries: 2, pending_bytes: 18234, failing_entries: 1, host_unreachable_entries: 1 },
          plan: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
          event_replay: { pending_entries: 3, pending_records: 9, failing_entries: 0, host_unreachable_entries: 0 },
        },
      }],
    };
    renderHostTab();

    expect(screen.getByText(/2 pending \(18,234 bytes\) · 1 failing/)).toBeInTheDocument();
    expect(screen.getByText(/3 pending \(9 records\)/)).toBeInTheDocument();
  });
});

describe('Team settings — per-host selection (Task 9)', () => {
  it('with no joined hosts, mounts the panel targeting "This machine" and shows no selector', () => {
    statusFixture = { hosts: [], hint: null };
    renderHostTab();

    expect(screen.getByText('Team settings')).toBeInTheDocument();
    expect(screen.queryByLabelText('Configure team for')).not.toBeInTheDocument();
    expect(teamTargetCalls).toEqual([{ carrier: null }]);
  });

  it('a joined host with no attached project is left out of the selector (no carrier available)', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1,
        protocol_version: 1, created_at: '', projects: [],
      }],
      hint: null,
    };
    renderHostTab();

    expect(screen.queryByLabelText('Configure team for')).not.toBeInTheDocument();
    expect(teamTargetCalls).toEqual([{ carrier: null }]);
  });

  it('a joined host with an attached project appears in the selector alongside "This machine"', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1,
        protocol_version: 1, created_at: '',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout' }],
      }],
      hint: null,
    };
    renderHostTab();

    const select = screen.getByLabelText('Configure team for') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(['This machine', 'Mac Studio (host_abc)']);
    // Defaults to "This machine" — no carrier — until the operator picks a host.
    expect(select.value).toBe('self');
    expect(teamTargetCalls).toEqual([{ carrier: null }]);
  });

  it('prefers a non-mismatched ref as the team-settings carrier when the first ref is mismatch-flagged', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1,
        protocol_version: 1, created_at: '',
        projects: [
          { grove_id: 'grove_stale', project_id: 'proj_stale', root: '/checkout-stale', mismatch: 'attach_grove_mismatch' },
          { grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout', mismatch: null },
        ],
      }],
      hint: null,
    };
    renderHostTab();

    const select = screen.getByLabelText('Configure team for') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'host_abc' } });

    expect(teamTargetCalls.at(-1)).toEqual({ carrier: { groveId: 'grove_x', projectId: 'proj_x' } });
  });

  it('falls back to the first ref as the team-settings carrier when every ref on the host is mismatch-flagged', () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1,
        protocol_version: 1, created_at: '',
        projects: [
          { grove_id: 'grove_stale', project_id: 'proj_stale', root: '/checkout-stale', mismatch: 'attach_grove_mismatch' },
        ],
      }],
      hint: null,
    };
    renderHostTab();

    const select = screen.getByLabelText('Configure team for') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'host_abc' } });

    expect(teamTargetCalls.at(-1)).toEqual({ carrier: { groveId: 'grove_stale', projectId: 'proj_stale' } });
  });

  it('selecting a joined host switches the team target to that host\'s carrier', async () => {
    statusFixture = {
      hosts: [{
        host_id: 'host_abc', label: 'Mac Studio', overlay_address: 'a', proxy_port: 1,
        protocol_version: 1, created_at: '',
        projects: [{ grove_id: 'grove_x', project_id: 'proj_x', root: '/checkout' }],
      }],
      hint: null,
    };
    renderHostTab();

    const select = screen.getByLabelText('Configure team for') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'host_abc' } });

    await waitFor(() => expect(select.value).toBe('host_abc'));
    expect(teamTargetCalls.at(-1)).toEqual({ carrier: { groveId: 'grove_x', projectId: 'proj_x' } });
  });

  it('surfaces keyHealth as the status line', () => {
    teamKeyHealth = 'ok';
    statusFixture = { hosts: [], hint: null };
    renderHostTab();

    expect(screen.getByText(/a team key is configured/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Host detail slideout (E-4 W1 Task T5) — page-wide selected host, additive:
// the host list, DrainHealthPanel, and AttachProjectPanel below still render
// every host exactly as before; selecting one only opens the detail surface.
// ---------------------------------------------------------------------------

const hostA = {
  host_id: 'host_a', label: 'Mac Studio', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
  protocol_version: 1, created_at: '2026-01-01T00:00:00Z', projects: [],
};
const hostB = {
  host_id: 'host_b', label: 'Linux Box', overlay_address: '100.64.0.2:7433', proxy_port: 41201,
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
    expect(within(panel).getByText('100.64.0.2:7433')).toBeInTheDocument();
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
  it('Leave host is reachable from the slideout and calls useLeaveHost with the host id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    statusFixture = { hosts: [hostA], hint: null };
    renderHostTab();
    fireEvent.click(screen.getByRole('button', { name: /view mac studio details/i }));

    const panel = screen.getByTestId('host-detail-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /leave host/i }));

    await waitFor(() => expect(leaveMutateAsync).toHaveBeenCalledWith('host_a'));
    confirmSpy.mockRestore();
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
