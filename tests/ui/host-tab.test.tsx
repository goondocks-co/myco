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
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

let statusFixture: { hosts: unknown[]; hint: unknown } = { hosts: [], hint: null };
let drainFixture: { hosts: unknown[] } = { hosts: [] };

mock.module('../../packages/myco/ui/src/hooks/use-host-membership', () => ({
  useHostMembershipStatus: () => ({ data: statusFixture, isLoading: false }),
  useJoinHost: () => ({ mutateAsync: joinMutateAsync, isPending: false }),
  useLeaveHost: () => ({ mutateAsync: leaveMutateAsync, isPending: false }),
  useAttachProject: () => ({ mutateAsync: attachMutateAsync, isPending: false }),
  useDetachProject: () => ({ mutateAsync: detachMutateAsync, isPending: false }),
  useDrainHealth: () => ({ data: drainFixture, isLoading: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => null,
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
  joinMutateAsync.mockClear();
  leaveMutateAsync.mockClear();
  attachMutateAsync.mockClear();
  detachMutateAsync.mockClear();
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

  it('takes an operator-typed project path (never a picker of already-locally-registered projects), and submits project_root/host_id/grove_id', async () => {
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
    fireEvent.change(screen.getByLabelText('Grove id (on the host)'), { target: { value: 'grove_y' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(attachMutateAsync).toHaveBeenCalledWith({
      project_root: '/checkout/fresh', host_id: 'host_abc', grove_id: 'grove_y',
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
    fireEvent.change(screen.getByLabelText('Grove id (on the host)'), { target: { value: 'grove_y' } });
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
