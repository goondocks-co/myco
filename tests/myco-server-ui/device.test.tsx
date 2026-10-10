import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { createQueryClient } from '../../packages/myco-server/ui/src/lib/query-client';
import { pendingDeviceCode } from '../../packages/myco-server/ui/src/lib/pending-device';
import { dashboardMe } from '../helpers/dashboard-permissions';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; pendingDeviceCode(null); window.history.replaceState(null, '', '/'); });
const ME = dashboardMe({ sub: '168901', login: 'test', owner: false, member: { id: 'mem_test', label: 'Test', role: 'member' } });
const PREVIEW = { machineName: 'SSH laptop', os: 'linux', ip: '192.0.2.10', approverIp: '192.0.2.20', ageSeconds: 42, alreadyYours: true, scope: 'membership', expiresAt: Date.now() + 600000 };

function mount(path = '/device') {
  window.history.replaceState(null, '', '/device?code=BCDF-2345');
  return render(<StrictMode><QueryClientProvider client={createQueryClient({ retryDelay: 0 })}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></StrictMode>);
}

describe('device approval page', () => {
  it('prefills a valid URL code but still requires checking before approval', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return Response.json(ME); }) as typeof fetch;
    mount('/device?code=bcdf-2345');
    expect(await screen.findByText('Check machine')).toBeTruthy();
    expect((screen.getByLabelText('Code from your terminal') as HTMLInputElement).value).toBe('BCDF-2345');
    expect(new Set(calls)).toEqual(new Set(['/auth/me']));
    expect(screen.queryByText('Approve this machine')).toBeNull();
  });

  for (const state of ['unclaimed', 'unlinked'] as const) {
    it(`names the recovery for ${state} without offering device actions`, async () => {
      globalThis.fetch = (async () => Response.json({ ...ME, member: null, membership: { state, reason: null } })) as typeof fetch;
      mount();
      expect(await screen.findByText(state === 'unclaimed' ? /myco server setup-owner/ : /Ask an owner or admin/)).toBeTruthy();
      expect(screen.queryByText('Check machine')).toBeNull();
    });
  }

  it('shows the server reason for inactive membership and offers no device actions', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async input => {
      calls.push(String(input));
      return Response.json({ ...ME, member: null, membership: { state: 'inactive', reason: 'Your membership is no longer active.' } });
    }) as typeof fetch;
    mount();
    expect(await screen.findByText('Your membership is no longer active.')).toBeTruthy();
    expect(screen.queryByText('Check machine')).toBeNull();
    expect(screen.queryByText('Approve this machine')).toBeNull();
    expect(screen.queryByText('Deny')).toBeNull();
    expect(new Set(calls)).toEqual(new Set(['/auth/me']));
  });

  for (const decision of ['approve', 'deny']) {
    it(`shows the code, machine, OS and IP before ${decision}, and posts only the human code`, async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === '/auth/me') return Response.json(ME);
        if (url === '/api/device/preview') return Response.json(PREVIEW);
        return Response.json({ [decision === 'approve' ? 'approved' : 'denied']: true });
      }) as typeof fetch;
      mount();
      const check = await screen.findByText('Check machine');
      expect(screen.queryByText('Approve this machine')).toBeNull();
      expect((screen.getByLabelText('Code from your terminal') as HTMLInputElement).value).toBe('');
      fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'BCDF-2345' } });
      fireEvent.click(check);
      expect(await screen.findByText('SSH laptop')).toBeTruthy();
      expect(screen.getByText('linux')).toBeTruthy();
      expect(screen.getByText('192.0.2.20')).toBeTruthy();
      expect(screen.getByText('42 seconds ago')).toBeTruthy();
      expect(screen.getByText(/reported by the requesting machine/)).toBeTruthy();
      expect(screen.getByText(/request IP differs/)).toBeTruthy();
      expect(screen.getByText(/already one of your machines/)).toBeTruthy();
      expect(screen.getByText('192.0.2.10')).toBeTruthy();
      expect(screen.getByText('BCDF-2345')).toBeTruthy();
      fireEvent.click(screen.getByText(decision === 'approve' ? 'Approve this machine' : 'Deny'));
      expect(await screen.findByText(decision === 'approve' ? 'Approved. Return to your terminal to finish signing in.' : 'Denied. This machine will not be signed in.')).toBeTruthy();
      expect(calls.filter(c => c.url.startsWith('/api/device/'))).toEqual([
        { url: '/api/device/preview', body: { user_code: 'BCDF-2345' } },
        { url: `/api/device/${decision}`, body: { user_code: 'BCDF-2345' } },
      ]);
    });
  }

  it('keeps the human code across GitHub sign-in and resumes the device page at the callback landing', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    mount();
    const link = await screen.findByText('Sign in with GitHub');
    fireEvent.click(link);
    expect(pendingDeviceCode()).toBe('');
    cleanup();
    globalThis.fetch = (async () => Response.json(ME)) as typeof fetch;
    mount('/');
    expect(await screen.findByText('Check machine')).toBeTruthy();
    expect((screen.getByLabelText('Code from your terminal') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(pendingDeviceCode()).toBeNull());
  });

  it('resumes a previously typed code once without leaving a callback redirect', async () => {
    pendingDeviceCode('BCDF-2345');
    globalThis.fetch = (async () => Response.json(ME)) as typeof fetch;
    mount('/');
    await screen.findByText('Check machine');
    expect((screen.getByLabelText('Code from your terminal') as HTMLInputElement).value).toBe('BCDF-2345');
    await waitFor(() => expect(pendingDeviceCode()).toBeNull());
  });

  it('clears pending storage when an approval fails', async () => {
    globalThis.fetch = (async input => String(input) === '/auth/me' ? Response.json(ME)
      : String(input) === '/api/device/preview' ? Response.json(PREVIEW)
        : Response.json({ error: 'approval_refused' }, { status: 409 })) as typeof fetch;
    mount();
    await screen.findByText('Check machine');
    fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'BCDF-2345' } });
    fireEvent.click(screen.getByText('Check machine'));
    await screen.findByText('Approve this machine');
    pendingDeviceCode('BCDF-2345');
    fireEvent.click(screen.getByText('Approve this machine'));
    expect((await screen.findByText(/This code has expired/)).textContent).toContain('myco runner register');
    await waitFor(() => expect(pendingDeviceCode()).toBeNull());
  });

  it('a non-owner admin can approve their own machine at their own role', async () => {
    globalThis.fetch = (async input => String(input) === '/auth/me'
      ? Response.json({ ...ME, member: { ...ME.member, role: 'admin' } }) : Response.json(PREVIEW)) as typeof fetch;
    mount();
    await screen.findByText('Check machine');
    fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'BCDF-2345' } });
    fireEvent.click(screen.getByText('Check machine'));
    expect(await screen.findByText('SSH laptop')).toBeTruthy();
    expect((screen.getByText('Approve this machine') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('Deny') as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards an old preview after the code changes and approves only the newly checked machine', async () => {
    let deliver: (response: Response) => void = () => { throw new Error('preview not requested'); };
    const decisions: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) === '/auth/me') return Response.json(ME);
      const body = JSON.parse(String(init?.body)) as { user_code: string };
      if (String(input) === '/api/device/preview') {
        if (body.user_code === 'BCDF-2345') return new Promise<Response>(resolve => { deliver = resolve; });
        return Response.json({ ...PREVIEW, machineName: 'New machine' });
      }
      decisions.push(body);
      return Response.json({ approved: true });
    }) as typeof fetch;
    mount();
    await screen.findByText('Check machine');
    fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'BCDF-2345' } });
    fireEvent.click(screen.getByText('Check machine'));
    fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'GHJK-6789' } });
    deliver(Response.json(PREVIEW));
    await waitFor(() => expect((screen.getByText('Check machine') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('SSH laptop')).toBeNull();
    expect(screen.queryByText('Approve this machine')).toBeNull();
    fireEvent.click(screen.getByText('Check machine'));
    expect(await screen.findByText('New machine')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve this machine'));
    await screen.findByText('Approved. Return to your terminal to finish signing in.');
    expect(decisions).toEqual([{ user_code: 'GHJK-6789' }]);
  });

  it('surfaces expiry and never approves when the preview fails', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async input => {
      const url = String(input); calls.push(url);
      return url === '/auth/me' ? Response.json(ME) : Response.json({ error: 'expired_token' }, { status: 400 });
    }) as typeof fetch;
    mount();
    await screen.findByText('Check machine');
    fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'BCDF-2345' } });
    pendingDeviceCode('BCDF-2345');
    fireEvent.click(screen.getByText('Check machine'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('expired'));
    expect(screen.queryByText('Approve this machine')).toBeNull();
    expect(calls).not.toContain('/api/device/approve');
    expect(pendingDeviceCode()).toBeNull();
  });

  it('shows the replacement target and loss of current authority before approving the same runner', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async input => {
      const url = String(input); calls.push(url);
      if (url === '/auth/me') return Response.json({ ...ME, member: { ...ME.member, role: 'admin' } });
      if (url === '/api/device/preview') return Response.json({ ...PREVIEW, subject: 'runner', runnerName: 'homelab-mini', replacingRunnerId: 'rn_mini', scope: 'runner' });
      return Response.json({ approved: true });
    }) as typeof fetch;
    mount();
    await screen.findByText('Check machine');
    fireEvent.change(screen.getByLabelText('Code from your terminal'), { target: { value: 'BCDF-2345' } });
    fireEvent.click(screen.getByText('Check machine'));
    expect(await screen.findByRole('heading', { name: 'Replace registration for homelab-mini' })).toBeTruthy();
    expect(screen.getByText(/keeps the runner’s history and ID/)).toBeTruthy();
    expect(screen.getByText(/ends its current registration and authority/)).toBeTruthy();
    expect(screen.getByText('SSH laptop')).toBeTruthy();
    expect(screen.getByText('linux')).toBeTruthy();
    expect(screen.getByText('192.0.2.10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace this runner' }));
    expect(await screen.findByText(/Replacement approved/)).toBeTruthy();
    expect(calls).toContain('/api/device/approve-runner');
  });
});
