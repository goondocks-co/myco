// @vitest-environment jsdom

/**
 * `ExternalAccessPanel` (E1 §5.2, Tab 2) — the external surface promoted out
 * of `TeamSettingsPanel`. Only `lib/api` is mocked; the real
 * `teamCarrierHeaders` runs, so every assertion below pins the ACTUAL request
 * shape each of the three calls produces for a given target. That is the
 * whole point of the panel's rewrite: before it, these three requests carried
 * no context headers at all and routed by whatever project the topbar last
 * browsed (a rotate could hit a different host and still show success).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from '../helpers/vi-shim.js';

const fetchJsonMock = vi.fn();
const putJsonMock = vi.fn();
const postJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  putJson: (...args: unknown[]) => putJsonMock(...args),
  postJson: (...args: unknown[]) => postJsonMock(...args),
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

import { ExternalAccessPanel } from '../../packages/myco/ui/src/components/team/ExternalAccessPanel';
import type { TeamConfigTarget } from '../../packages/myco/ui/src/hooks/use-scoped-config';

const HOST_TARGET: TeamConfigTarget = { carrier: { hostId: 'host_x' } };
const SELF_TARGET: TeamConfigTarget = { carrier: null };
// Grove/project ride along as explicit EMPTY so an ambient project selection
// can't shadow the host-id branch at the server chokepoint.
const HOST_HEADERS = { 'x-myco-host-id': 'host_x', 'x-myco-grove-id': '', 'x-myco-project-id': '' };
const SELF_HEADERS = { 'x-myco-grove-id': '', 'x-myco-project-id': '' };

function stubStatus(status: { enabled: boolean; tokenHash?: string | null; bound?: boolean | null; funnel_url?: string | null }) {
  fetchJsonMock.mockImplementation(async (path: string) => {
    if (path === '/team/external-mcp') {
      return { tokenHash: null, bound: null, ...status };
    }
    throw new Error(`unexpected fetchJson call: ${path}`);
  });
}

function renderPanel(target: TeamConfigTarget = HOST_TARGET) {
  return render(<ExternalAccessPanel target={target} />);
}

beforeEach(() => {
  fetchJsonMock.mockReset();
  putJsonMock.mockReset();
  postJsonMock.mockReset();
});

describe('ExternalAccessPanel — every call carries the target', () => {
  it('reads status for the selected HOST, not the ambient project', async () => {
    stubStatus({ enabled: false });
    renderPanel();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/team/external-mcp', { headers: HOST_HEADERS }));
    await waitFor(() => expect(screen.getByTestId('external-access-status')).toHaveTextContent('off'));
  });

  it('reads status for "This machine" with explicit empty grove/project and no host id', async () => {
    stubStatus({ enabled: false });
    renderPanel(SELF_TARGET);

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/team/external-mcp', { headers: SELF_HEADERS }));
    expect(fetchJsonMock.mock.calls[0]?.[1]).not.toHaveProperty('headers.x-myco-host-id');
  });

  it('toggling on PUTs the target\'s headers and re-reads status', async () => {
    stubStatus({ enabled: false });
    putJsonMock.mockResolvedValue({ enabled: true, funnel_url: 'https://box.ts.net' });
    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: /turn on external access/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /turn on external access/i }));

    await waitFor(() => expect(putJsonMock).toHaveBeenCalledWith(
      '/team/external-mcp/toggle',
      { enabled: true },
      { headers: HOST_HEADERS },
    ));
    // The re-read is the target's too — a status refresh that lost the carrier
    // would show a different host's state next to the button just pressed.
    await waitFor(() => expect(fetchJsonMock.mock.calls.length).toBeGreaterThan(1));
    expect(fetchJsonMock.mock.calls.at(-1)).toEqual(['/team/external-mcp', { headers: HOST_HEADERS }]);
  });

  it('rotating POSTs the target\'s headers', async () => {
    stubStatus({ enabled: true, tokenHash: 'abc123' });
    postJsonMock.mockResolvedValue({ token: 'mycotok_rotated', tokenHash: 'def456' });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /rotate token/i }));

    await waitFor(() => expect(postJsonMock).toHaveBeenCalledWith(
      '/team/mcp-token/rotate',
      undefined,
      { headers: HOST_HEADERS },
    ));
  });
});

describe('ExternalAccessPanel — surfaced state', () => {
  it('surfaces a status-read failure instead of a silent "status unavailable"', async () => {
    fetchJsonMock.mockRejectedValue(new Error('team host is not reachable'));
    renderPanel();

    // The old panel swallowed this into a bare "status unavailable" with no
    // cause — the silent-unconfigurable class this testid exists to prevent.
    await waitFor(() => expect(screen.getByTestId('external-access-error')).toHaveTextContent(/not reachable/));
    expect(screen.getByTestId('external-access-status')).toHaveTextContent('status unavailable');
  });

  it('reveals a freshly minted token once, with the copy-it-now warning', async () => {
    stubStatus({ enabled: false });
    putJsonMock.mockResolvedValue({ enabled: true, funnel_url: 'https://box.ts.net', token: 'mycotok_minted' });
    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: /turn on external access/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /turn on external access/i }));

    await waitFor(() => expect(screen.getByText('mycotok_minted')).toBeInTheDocument());
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
    expect(screen.getByText('https://box.ts.net')).toBeInTheDocument();
  });

  it('offers the ready-to-paste MCP config only once external access is on, addressed at the public URL', async () => {
    stubStatus({ enabled: false });
    const { rerender } = renderPanel();
    await waitFor(() => expect(screen.getByTestId('external-access-status')).toHaveTextContent('off'));
    expect(screen.queryByRole('button', { name: /ready-to-paste mcp config/i })).toBeNull();

    stubStatus({ enabled: true, funnel_url: 'https://box.ts.net' });
    rerender(<ExternalAccessPanel key="remount" target={HOST_TARGET} />);

    const disclosure = await screen.findByRole('button', { name: /ready-to-paste mcp config/i });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(disclosure);

    await waitFor(() => expect(screen.getByText(/box\.ts\.net\/mcp/)).toBeInTheDocument());
  });
});
