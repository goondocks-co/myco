/**
 * `myco attach`/`myco detach` CLI surface (consolidation Task D-2: fallback
 * posture). `cli/attach.ts` no longer calls `attachCommand`/`detachCommand`
 * in-process; it POSTs to the SAME daemon route
 * (`/api/host-membership/attach|detach`) the Team page's attach control uses.
 * That route's own mapping is covered by `tests/daemon/api/host-membership.test.ts`;
 * these tests pin only the CLI wrapper's job — resolving the project path,
 * the daemon POST it issues, and how it renders the response.
 * `attachCommand`/`detachCommand` themselves stay covered by
 * `tests/host/attach-command.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';

const { fakeDaemon } = vi.hoisted(() => {
  const fakeDaemon: {
    postResult: { ok: boolean; data?: unknown };
    postCalls: { endpoint: string; body: unknown }[];
  } = { postResult: { ok: true, data: {} }, postCalls: [] };
  return { fakeDaemon };
});

mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: class {
    constructor(_vaultDir: string, _options?: unknown) {}
    async ensureRunning() { return true; }
    async post(endpoint: string, body: unknown) {
      fakeDaemon.postCalls.push({ endpoint, body });
      return fakeDaemon.postResult;
    }
  },
}));

import { runAttach, runDetach } from '@myco/cli/attach.js';

describe('myco attach / myco detach (daemon API fallback)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeDaemon.postResult = { ok: true, data: {} };
    fakeDaemon.postCalls = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('attach resolves the checkout path client-side and POSTs project_root/host_id (no grove_id — the daemon sources it from the host record)', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: { project_id: 'proj_x', grove_id: 'grove_x', host_id: 'host_abc', host_label: 'Mac Studio', root: '/checkout', already_attached: false, notes: [] },
    };
    await runAttach(['/checkout', '--host', 'host_abc'], '/tmp/vault');

    expect(fakeDaemon.postCalls).toHaveLength(1);
    const call = fakeDaemon.postCalls[0]!;
    expect(call.endpoint).toBe('/api/host-membership/attach');
    expect(call.body).toEqual({ project_root: path.resolve('/checkout'), host_id: 'host_abc', project_id: undefined });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Attached proj_x to Team Host host_abc'))).toBe(true);
  });

  it('attach defaults the project path to cwd when omitted', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: { project_id: 'proj_x', grove_id: 'g', host_id: 'h', host_label: 'l', root: process.cwd(), already_attached: false, notes: [] },
    };
    await runAttach(['--host', 'h'], '/tmp/vault');
    expect(fakeDaemon.postCalls[0]!.body).toMatchObject({ project_root: path.resolve('.') });
  });

  it('attach prints the already-attached message when the daemon converges', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: { project_id: 'proj_x', grove_id: 'g', host_id: 'h', host_label: 'l', root: '/checkout', already_attached: true, notes: [] },
    };
    await runAttach(['/checkout', '--host', 'h'], '/tmp/vault');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('already attached'))).toBe(true);
  });

  it('attach surfaces a daemon-side failure message and exits 1', async () => {
    fakeDaemon.postResult = { ok: false, data: { error: { code: 'attach_failed', message: 'Unknown host host_abc' } } };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(runAttach(['/checkout', '--host', 'host_abc'], '/tmp/vault')).rejects.toThrow('__exit__');
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Unknown host host_abc'))).toBe(true);

    exitSpy.mockRestore();
  });

  it('detach POSTs project_root and reports the host it was detached from', async () => {
    fakeDaemon.postResult = { ok: true, data: { project_id: 'proj_x', detached_from_host_id: 'host_abc' } };
    await runDetach(['/checkout'], '/tmp/vault');
    expect(fakeDaemon.postCalls[0]).toEqual({
      endpoint: '/api/host-membership/detach',
      body: { project_root: path.resolve('/checkout'), project_id: undefined },
    });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Disconnect started for proj_x (from Team Host host_abc)'))).toBe(true);
  });

  it('detach on an unattached project reports "nothing to detach" without exiting non-zero', async () => {
    fakeDaemon.postResult = { ok: true, data: { project_id: 'proj_x', detached_from_host_id: null } };
    await runDetach(['/checkout'], '/tmp/vault');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('nothing to detach'))).toBe(true);
  });
});
