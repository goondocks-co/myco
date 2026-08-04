/**
 * `myco join`/`myco leave` CLI surface (consolidation Task D-2: fallback
 * posture). PR #667 review direction: membership "should frankly be only the
 * UI and API, with the CLI being a secondary fallback" — `cli/join.ts` no
 * longer calls `joinHost`/`leaveHost` in-process; it POSTs to the SAME daemon
 * route (`/api/host-membership/join|leave`) the Team page's join form uses.
 * That route's own body-mapping/error-mapping is covered by
 * `tests/daemon/api/host-membership.test.ts`; these tests pin only the CLI
 * wrapper's job — flag parsing, the daemon POST it issues, and how it renders
 * the response (or a failure) to the terminal. `joinHost`/`leaveHost`
 * themselves stay covered by `tests/cli/member-overlay.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

const { fakeDaemon } = vi.hoisted(() => {
  const fakeDaemon: {
    postResult: { ok: boolean; data?: unknown };
    postCalls: { endpoint: string; body: unknown; timeoutMs?: number }[];
    healthy: boolean;
    ensureRunningCalls: number;
  } = { postResult: { ok: true, data: {} }, postCalls: [], healthy: true, ensureRunningCalls: 0 };
  return { fakeDaemon };
});

mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: class {
    constructor(_vaultDir: string, _options?: unknown) {}
    async ensureRunning() { fakeDaemon.ensureRunningCalls += 1; return true; }
    async isHealthy() { return fakeDaemon.healthy; }
    async post(endpoint: string, body: unknown, options?: { timeoutMs?: number }) {
      fakeDaemon.postCalls.push({ endpoint, body, timeoutMs: options?.timeoutMs });
      return fakeDaemon.postResult;
    }
  },
}));

import { runJoin, runLeave } from '@myco/cli/join.js';

describe('myco join / myco leave (daemon API fallback)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeDaemon.postResult = { ok: true, data: {} };
    fakeDaemon.postCalls = [];
    fakeDaemon.healthy = true;
    fakeDaemon.ensureRunningCalls = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('join POSTs the flags mapped to snake_case host-membership fields', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: {
        host_id: 'host_abc', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
        member_overlay_ip: '100.64.0.5', host_reachable: true, created: true, notes: [],
      },
    };

    await runJoin(
      ['host_abc', '--key', 'onetime', '--server-url', 'https://h:8080', '--hostname', 'my-mac'],
      '/tmp/vault',
    );

    expect(fakeDaemon.postCalls).toHaveLength(1);
    const call = fakeDaemon.postCalls[0]!;
    expect(call.endpoint).toBe('/api/host-membership/join');
    expect(call.body).toMatchObject({
      host_ref: 'host_abc', key: 'onetime', server_url: 'https://h:8080', hostname: 'my-mac',
    });
    expect(call.timeoutMs).toBeGreaterThan(2000); // join dwarfs the default 2s client timeout
  });

  it('join prints "Joined" for a fresh host and "Re-joined" for a converging one', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: { host_id: 'h', overlay_address: 'a', proxy_port: 1, member_overlay_ip: 'ip', host_reachable: true, created: false, notes: [] },
    };
    await runJoin(['h', '--key', 'k', '--server-url', 'https://h:8080'], '/tmp/vault');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Re-joined'))).toBe(true);
  });

  it('join announces itself up front — the daemon runs the whole enrollment before answering, so the terminal must not sit silent', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: { host_id: 'host_abc', overlay_address: 'a', proxy_port: 1, member_overlay_ip: 'ip', host_reachable: true, created: true, notes: [] },
    };
    await runJoin(['host_abc', '--key', 'k', '--server-url', 'https://h:8080'], '/tmp/vault');

    // Keyed on the identity in the message, not its wording — the property is
    // that SOMETHING prints before the blocking POST, so the terminal is never
    // silent while the daemon works. The phrasing is free to change.
    const upfrontIndex = logSpy.mock.calls.findIndex((c) => String(c[0]).includes('Joining Team Host host_abc'));
    expect(upfrontIndex).toBeGreaterThanOrEqual(0);
    // Printed BEFORE the POST result renders — it is the waiting message.
    const joinedIndex = logSpy.mock.calls.findIndex((c) => String(c[0]).includes('Joined Team Host'));
    expect(upfrontIndex).toBeLessThan(joinedIndex);
  });

  it('join replays the daemon-collected step log after the POST returns', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: {
        host_id: 'host_abc', overlay_address: 'a', proxy_port: 1, member_overlay_ip: 'ip',
        host_reachable: true, created: true, notes: [],
        steps: ['Provisioning Tailscale for darwin/arm64…', 'Joining the overlay with the one-time key…'],
      },
    };
    await runJoin(['host_abc', '--key', 'k', '--server-url', 'https://h:8080'], '/tmp/vault');

    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Provisioning Tailscale'))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Joining the overlay with the one-time key'))).toBe(true);
  });

  it('join tolerates a steps-less response (daemon mid-upgrade) without failing', async () => {
    fakeDaemon.postResult = {
      ok: true,
      data: { host_id: 'h', overlay_address: 'a', proxy_port: 1, member_overlay_ip: 'ip', host_reachable: true, created: true, notes: [] },
    };
    await runJoin(['h', '--key', 'k', '--server-url', 'https://h:8080'], '/tmp/vault');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Joined Team Host'))).toBe(true);
  });

  it('join without <host> or --key exits before touching the daemon', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(runJoin([], '/tmp/vault')).rejects.toThrow('__exit__');
    await expect(runJoin(['host_abc'], '/tmp/vault')).rejects.toThrow('__exit__');
    expect(fakeDaemon.postCalls).toHaveLength(0);

    exitSpy.mockRestore();
  });

  it('join surfaces a daemon-side failure message and exits 1', async () => {
    fakeDaemon.postResult = { ok: false, data: { error: { code: 'join_failed', message: 'tailscaled socket did not appear' } } };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(runJoin(['h', '--key', 'k'], '/tmp/vault')).rejects.toThrow('__exit__');
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('tailscaled socket did not appear'))).toBe(true);

    exitSpy.mockRestore();
  });

  it('join with no running daemon refuses BEFORE the POST and never spawns one (the key-burn preflight)', async () => {
    // The daemon-side join burns the single-use overlay key at `tailscale up`;
    // an ensureRunning()-spawned daemon can die mid-join after the burn (E-5
    // Linux validation). The preflight must refuse with nothing spent: no
    // POST, no spawn attempt, and copy that says the key is still good.
    fakeDaemon.healthy = false;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(runJoin(['h', '--key', 'k', '--server-url', 'https://h:8080'], '/tmp/vault')).rejects.toThrow('__exit__');
    expect(fakeDaemon.postCalls).toHaveLength(0);
    expect(fakeDaemon.ensureRunningCalls).toBe(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('The key has NOT been used'))).toBe(true);

    exitSpy.mockRestore();
  });

  it('join timeout with no response body steers to a converging re-run, not a blind fresh key', async () => {
    fakeDaemon.postResult = { ok: false, data: undefined };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(runJoin(['h', '--key', 'k', '--server-url', 'https://h:8080'], '/tmp/vault')).rejects.toThrow('__exit__');
    const errText = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errText).toContain('did not respond within the join window');
    expect(errText).toContain('Re-run the SAME join command');
    expect(errText).toContain('authkey already used');

    exitSpy.mockRestore();
  });

  it('leave POSTs { host_ref } and reports removal', async () => {
    fakeDaemon.postResult = { ok: true, data: { removed: true, tailscaled_removed: true, notes: ['n1'] } };
    await runLeave(['host_abc'], '/tmp/vault');
    expect(fakeDaemon.postCalls[0]).toMatchObject({ endpoint: '/api/host-membership/leave', body: { host_ref: 'host_abc' } });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Left Team Host host_abc'))).toBe(true);
  });

  it('leave on an unknown host reports "nothing to remove" without exiting non-zero', async () => {
    fakeDaemon.postResult = { ok: true, data: { removed: false, tailscaled_removed: false, notes: [] } };
    await runLeave(['host_xyz'], '/tmp/vault');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('nothing to remove'))).toBe(true);
  });

  it('leave without <host> exits before touching the daemon', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    await expect(runLeave([], '/tmp/vault')).rejects.toThrow('__exit__');
    expect(fakeDaemon.postCalls).toHaveLength(0);
    exitSpy.mockRestore();
  });
});
