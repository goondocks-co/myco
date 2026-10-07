import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { createQueryClient } from '../../packages/myco-server/ui/src/lib/query-client';
import { pendingDeviceCode } from '../../packages/myco-server/ui/src/lib/pending-device';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; pendingDeviceCode(null); window.history.replaceState(null, '', '/'); });
const ME = { sub: '168901', login: 'test', owner: false, member: { id: 'mem_test', label: 'Test', role: 'member' } };
const PREVIEW = { machineName: 'SSH laptop', os: 'linux', ip: '192.0.2.10', scope: 'membership', expiresAt: Date.now() + 600000 };

function mount(path = '/device') {
  window.history.replaceState(null, '', '/device?code=BCDF-2345');
  return render(<QueryClientProvider client={createQueryClient({ retryDelay: 0 })}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>);
}

describe('device approval page', () => {
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
      fireEvent.click(check);
      expect(await screen.findByText('SSH laptop')).toBeTruthy();
      expect(screen.getByText('linux')).toBeTruthy();
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
    expect(pendingDeviceCode()).toBe('BCDF-2345');
    cleanup();
    globalThis.fetch = (async () => Response.json(ME)) as typeof fetch;
    mount('/');
    expect(await screen.findByText('Check machine')).toBeTruthy();
    expect((screen.getByLabelText('Code from your terminal') as HTMLInputElement).value).toBe('BCDF-2345');
  });

  it('a non-owner admin sees the authority restriction before approval', async () => {
    globalThis.fetch = (async input => String(input) === '/auth/me'
      ? Response.json({ ...ME, member: { ...ME.member, role: 'admin' } }) : Response.json(PREVIEW)) as typeof fetch;
    mount();
    fireEvent.click(await screen.findByText('Check machine'));
    expect(await screen.findByText(/Only the owner can approve an admin machine/)).toBeTruthy();
    expect((screen.getByText('Approve this machine') as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.click(await screen.findByText('Check machine'));
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
    fireEvent.click(await screen.findByText('Check machine'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('expired'));
    expect(screen.queryByText('Approve this machine')).toBeNull();
    expect(calls).not.toContain('/api/device/approve');
  });
});
