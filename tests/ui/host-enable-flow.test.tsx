/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The enable-flow STATE MACHINE (E1 §4.1 client contract) — the region the
 * PR 4 review found entirely untested, which is exactly where its blocker
 * lived. Every pin here is a review finding made regression-proof:
 *
 *   B1 — no state without an exit: Dismiss renders in every non-done state,
 *        and a stale/malformed persisted run can never wedge the fork.
 *   C2 — the success state actually RENDERS (the old render-body reset
 *        discarded it), and clears the marker via effect.
 *   C3 — the restart discriminator FAILS CLOSED on a missing started_at.
 *   C4 — a transient not_serving_reason does not stop the Phase-2 poll;
 *        the key is per-token so a retry never inherits a stale verdict.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// api mock — the ONLY mock: hooks and panel run for real, so the state
// machine under test is the production one.
// ---------------------------------------------------------------------------
type Responder = (path: string) => unknown;
let respond: Responder = () => { throw new Error('no responder set'); };
const posts: Array<{ path: string; body: unknown }> = [];

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async (path: string) => {
    const result = respond(path);
    if (result instanceof Error) throw result;
    return result;
  },
  postJson: async (path: string, body?: unknown) => {
    posts.push({ path, body });
    const result = respond(path);
    if (result instanceof Error) throw result;
    return result;
  },
  putJson: async () => ({}),
}));

mock.module('../../packages/myco/ui/src/hooks/use-host-membership', () => ({
  useHostMembershipStatus: () => ({ data: { hosts: [], overlay_supported: true } }),
}));

const { HostATeamPanel, ENABLE_RUN_TTL_MS } = await import(
  '../../packages/myco/ui/src/pages/Team/HostATeamPanel'
);

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const RUN_KEY = 'myco.hostEnableRun';

describe('HostATeamPanel state machine', () => {
  beforeEach(() => {
    localStorage.clear();
    posts.length = 0;
  });
  afterEach(() => cleanup());

  it('B1: a persisted run older than the TTL is dropped before render — the form renders, never a dead spinner', () => {
    localStorage.setItem(RUN_KEY, JSON.stringify({
      token: 'tok-ancient', snapshot: 'T0', startedAtMs: Date.now() - ENABLE_RUN_TTL_MS - 1,
    }));
    respond = () => new Error('should not be called for an expired run');
    render(wrap(<HostATeamPanel />));
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
  });

  it('B1: a malformed persisted run (bad JSON shape) is dropped, not restored as a tokenless zombie', () => {
    localStorage.setItem(RUN_KEY, '"5"');
    respond = () => new Error('should not be called');
    render(wrap(<HostATeamPanel />));
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
  });

  it('B1: a job that FAILED before any restart shows the error step AND a Dismiss that frees the form', async () => {
    respond = (path) => {
      if (path === '/host-admin/enable') return { token: 'tok-1', started_at: 'T0' };
      if (path === '/progress/tok-1') {
        return { token: 'tok-1', type: 'host-admin', status: 'failed', steps: ['provisioning…', 'Enable failed: tailscale up exploded'] };
      }
      throw new Error(`unexpected ${path}`);
    };
    render(wrap(<HostATeamPanel />));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host a team' }));
    await waitFor(() => expect(screen.getByTestId('host-enable-steps')).toBeInTheDocument());
    expect(screen.getByText(/tailscale up exploded/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('host-enable-dismiss'));
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
  });

  it('B1: the waiting-for-restart state (deferred/hung restart) still offers Dismiss — no unbounded spinner without exit', async () => {
    respond = (path) => {
      if (path === '/host-admin/enable') return { token: 'tok-2', started_at: 'T0' };
      if (path === '/progress/tok-2') return { token: 'tok-2', type: 'host-admin', status: 'completed', steps: ['done step'] };
      // Phase 2: daemon never restarts — same started_at forever.
      if (path === '/host-serve/status') return { serving: false, not_serving_reason: 'restart_pending', started_at: 'T0', overlay_listener_bound: null };
      throw new Error(`unexpected ${path}`);
    };
    render(wrap(<HostATeamPanel />));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host a team' }));
    await waitFor(() => expect(screen.getByText(/waiting for the host to come up/)).toBeInTheDocument());
    expect(screen.getByTestId('host-enable-dismiss')).toBeInTheDocument();
  });

  it('C2: a successful run RENDERS the success state (Done button) instead of snapping back to the form', async () => {
    respond = (path) => {
      if (path === '/host-admin/enable') return { token: 'tok-3', started_at: 'T0' };
      if (path === '/progress/tok-3') return { token: 'tok-3', type: 'host-admin', status: 'completed', steps: ['Enable complete.'] };
      if (path === '/host-serve/status') return { serving: true, overlay_listener_bound: true, started_at: 'T1-new-process' };
      throw new Error(`unexpected ${path}`);
    };
    render(wrap(<HostATeamPanel />));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host a team' }));
    await waitFor(() => expect(screen.getByText('This machine is now serving your team.')).toBeInTheDocument());
    expect(screen.getByTestId('host-enable-done')).toBeInTheDocument();
    // Marker cleared by effect, not render-body side effect.
    await waitFor(() => expect(localStorage.getItem(RUN_KEY)).toBeNull());
    fireEvent.click(screen.getByTestId('host-enable-done'));
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
  });

  it('C3: FAIL CLOSED — serving+bound with a MISSING started_at never completes (the discriminator cannot be vacuous)', async () => {
    respond = (path) => {
      if (path === '/host-admin/enable') return { token: 'tok-4', started_at: 'T0' };
      if (path === '/progress/tok-4') return { token: 'tok-4', type: 'host-admin', status: 'completed', steps: [] };
      // Old daemon shape: no started_at. serving+bound alone MUST NOT complete.
      if (path === '/host-serve/status') return { serving: true, overlay_listener_bound: true };
      throw new Error(`unexpected ${path}`);
    };
    render(wrap(<HostATeamPanel />));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host a team' }));
    await waitFor(() => expect(screen.getByTestId('host-enable-progress')).toBeInTheDocument());
    // Give Phase 2 a poll cycle; success must NOT appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('This machine is now serving your team.')).toBeNull();
    expect(screen.getByTestId('host-enable-dismiss')).toBeInTheDocument();
  });

  it('C4: a transient not_serving_reason is surfaced but does NOT stop the poll — the flow self-recovers when the host binds', async () => {
    let statusCalls = 0;
    respond = (path) => {
      if (path === '/host-admin/enable') return { token: 'tok-5', started_at: 'T0' };
      if (path === '/progress/tok-5') return { token: 'tok-5', type: 'host-admin', status: 'completed', steps: [] };
      if (path === '/host-serve/status') {
        statusCalls += 1;
        // First read: restarted but momentarily misconfigured-looking.
        if (statusCalls === 1) return { serving: false, not_serving_reason: 'bearer_unavailable', started_at: 'T1', overlay_listener_bound: false };
        // Then the host comes up.
        return { serving: true, overlay_listener_bound: true, started_at: 'T1' };
      }
      throw new Error(`unexpected ${path}`);
    };
    render(wrap(<HostATeamPanel />));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host a team' }));
    // The transient failure must not latch: the poll continues (2s interval —
    // waitFor with a generous timeout observes the recovery).
    await waitFor(
      () => expect(screen.getByText('This machine is now serving your team.')).toBeInTheDocument(),
      { timeout: 6_000 },
    );
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it('refusals render operator guidance, not mechanism codes', async () => {
    respond = (path) => {
      if (path === '/host-admin/enable') return new Error('This machine’s daemon is boot-scoped, so the headscale unit lives in the system domain and enable/disable need sudo — which the daemon cannot request. Run `myco host enable` (host_admin_requires_cli)');
      throw new Error(`unexpected ${path}`);
    };
    render(wrap(<HostATeamPanel />));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://h:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host a team' }));
    await waitFor(() => expect(screen.getByTestId('host-enable-error')).toBeInTheDocument());
    expect(screen.getByTestId('host-enable-error').textContent).toContain('terminal');
  });
});
