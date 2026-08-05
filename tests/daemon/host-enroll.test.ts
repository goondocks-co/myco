/**
 * Team Host enrollment — the one route on the public team surface that is
 * exempt from the per-member token gate, driven through a real `DaemonServer`
 * over its real team socket.
 *
 * Restores the contracts deleted when the route was un-admitted (the 200
 * payload, the version gate applying to a token-exempt route, the 405, the
 * operator-boundary 404, the action-log append) and adds the ones that make
 * publishing it safe at all:
 *   - a request WITHOUT a valid, unexpired, unused key is refused;
 *   - the key is single-use — the second spend of the same key is refused;
 *   - success issues a PER-MEMBER token, never the shared host bearer;
 *   - the refusal shape does not distinguish invalid / expired / already-used,
 *     so the route is not an oracle for which keys were ever real.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { readHostActionLog } from '@myco/host/action-log';
import { HOST_PROTOCOL_VERSION } from '@myco/constants';
import { mintJoinKey } from '@myco/team-host/join-keys';
import { authenticateMemberToken, listMembers } from '@myco/team-host/member-tokens';
import { teamFetch, teamSocketPath } from '../helpers/team-socket.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-host-serve-bearer-0123456789abcdef';
const HOST_ID = 'hostid-abc123';
const HOST_LABEL = 'my-team-host';
const MEMBER_MACHINE = 'alice_a1b2c3d4';

// The team listener binds an AF_UNIX socket; it refuses to bind on Windows, so
// there is no surface to enroll against there.
const describeTeamTransport = process.platform === 'win32' ? describe.skip : describe;

describeTeamTransport('Team Host enrollment endpoint (/api/host/enroll)', () => {
  let tmp: string;
  let server: DaemonServer;
  let sessionsHandlerCalls: number;
  let savedTeamHome: string | undefined;
  let loopback: string;
  let socketPath: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enroll-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    // Empty attach registry (this daemon is the HOST), and the home the join-key
    // + member stores and action log all resolve under.
    process.env.MYCO_TEAM_HOME = tmp;

    sessionsHandlerCalls = 0;
    socketPath = teamSocketPath('enroll-host');
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      teamSocketPath: socketPath,
      hostServe: { bearer: HOST_BEARER, hostId: HOST_ID, label: HOST_LABEL },
      lockNamespace: testPerUserLockNamespace,
    });
    // A different team route, to prove the exemption did not widen the gate.
    server.registerRoute('GET', '/api/sessions', async () => {
      sessionsHandlerCalls += 1;
      return { body: { ok: true } };
    });
    await server.start(0);
    loopback = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const v1 = { 'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION) };
  const enrollHeaders = { 'Content-Type': 'application/json', ...v1 };
  const enroll = (body: Record<string, unknown>, headers: Record<string, string> = enrollHeaders) =>
    teamFetch(socketPath, '/api/host/enroll', { method: 'POST', headers, body: JSON.stringify(body) });

  // -------------------------------------------------------------------------
  // The gate that makes publishing this route safe
  // -------------------------------------------------------------------------

  test('WITHOUT a valid key → 401, and no member is issued', async () => {
    const res = await enroll({ key: 'not-a-real-key', machine_id: MEMBER_MACHINE });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('enrollment_unauthorized');
    expect(listMembers()).toEqual([]);
  });

  test('with NO key at all → the SAME 401, not a different error', async () => {
    // A caller must not learn from the response whether it got the request
    // FORM right — only whether it got in.
    const missing = await enroll({ machine_id: MEMBER_MACHINE });
    const wrong = await enroll({ key: 'nope', machine_id: MEMBER_MACHINE });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(await wrong.json());
  });

  test('a valid key → 200, and the bearer returned is a PER-MEMBER token, not the shared host bearer', async () => {
    const minted = mintJoinKey();
    const res = await enroll({ key: minted.key, machine_id: MEMBER_MACHINE, member_hostname: 'alices-mac' });

    expect(res.status).toBe(200);
    const body = await res.json() as { host_id: string; label: string; protocol_version: number; bearer: string };
    expect(body.host_id).toBe(HOST_ID);
    expect(body.label).toBe(HOST_LABEL);
    expect(body.protocol_version).toBe(HOST_PROTOCOL_VERSION);

    // The whole point of per-member tokens: what the member receives is NOT the
    // host's shared secret, and it authenticates as this member.
    expect(body.bearer).not.toBe(HOST_BEARER);
    const auth = authenticateMemberToken(body.bearer);
    expect(auth.ok).toBe(true);
    expect(auth.ok && auth.machineId).toBe(MEMBER_MACHINE);
  });

  test('the key is SINGLE USE — a second enrollment with it is refused', async () => {
    const minted = mintJoinKey();
    expect((await enroll({ key: minted.key, machine_id: MEMBER_MACHINE })).status).toBe(200);

    const second = await enroll({ key: minted.key, machine_id: 'bob_99887766' });
    expect(second.status).toBe(401);
    // And no second member was created.
    expect(listMembers().map((m) => m.machine_id)).toEqual([MEMBER_MACHINE]);
  });

  test('an EXPIRED key is refused, and indistinguishably from an invalid one', async () => {
    const minted = mintJoinKey({ ttlMs: 1, now: () => Date.now() - 60_000 });
    const expired = await enroll({ key: minted.key, machine_id: MEMBER_MACHINE });
    const invalid = await enroll({ key: 'never-existed', machine_id: MEMBER_MACHINE });

    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual(await invalid.json());
    expect(listMembers()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Contracts restored from the pre-transport suite
  // -------------------------------------------------------------------------

  test('echoes a deterministic additive receipt for a supplied enrollment nonce', async () => {
    const minted = mintJoinKey();
    const nonce = 'a'.repeat(32);
    const res = await enroll({ key: minted.key, machine_id: MEMBER_MACHINE, enrollment_nonce: nonce });
    const body = await res.json() as { enrollment_receipt?: { enrollment_nonce: string; host_id: string; protocol_version: number } };
    expect(body.enrollment_receipt).toEqual({
      enrollment_nonce: nonce,
      host_id: HOST_ID,
      protocol_version: HOST_PROTOCOL_VERSION,
    });
  });

  test('SURGICAL exemption: a DIFFERENT team route STILL 401s without a token', async () => {
    const res = await teamFetch(socketPath, '/api/sessions', { headers: v1 });
    expect(res.status).toBe(401);
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('TEAM-ONLY: enrollment on the localhost listener → 404', async () => {
    const minted = mintJoinKey();
    const res = await fetch(`${loopback}/api/host/enroll`, {
      method: 'POST',
      headers: enrollHeaders,
      body: JSON.stringify({ key: minted.key, machine_id: MEMBER_MACHINE }),
    });
    expect(res.status).toBe(404);
    // The key was NOT spent by a request that never enrolled anyone.
    expect((await enroll({ key: minted.key, machine_id: MEMBER_MACHINE })).status).toBe(200);
  });

  test('the version gate STILL applies to enrollment (token-exempt is not version-exempt)', async () => {
    const minted = mintJoinKey();
    const res = await enroll(
      { key: minted.key, machine_id: MEMBER_MACHINE },
      { 'Content-Type': 'application/json', 'x-myco-host-protocol': '1' },
    );
    expect(res.status).toBe(409);
  });

  test('a non-POST method on the enrollment route → 405', async () => {
    const res = await teamFetch(socketPath, '/api/host/enroll', { headers: v1 });
    expect(res.status).toBe(405);
  });

  test('OPERATOR BOUNDARY: a host-admin route 404s on the team surface even WITH a valid token', async () => {
    const minted = mintJoinKey();
    const enrolled = await enroll({ key: minted.key, machine_id: MEMBER_MACHINE });
    const token = ((await enrolled.json()) as { bearer: string }).bearer;

    for (const pathname of ['/api/host-admin/mint-join-key', '/api/host-admin/members', '/api/host-admin/revoke']) {
      const res = await teamFetch(socketPath, pathname, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...v1 },
        body: '{}',
      });
      // A member must never mint keys, list the roster, or revoke anyone.
      expect([403, 404]).toContain(res.status);
    }
  });

  test('enrollment appends one `enroll` record to the control-plane action log', async () => {
    const minted = mintJoinKey();
    await enroll({ key: minted.key, machine_id: MEMBER_MACHINE, member_hostname: 'alices-mac' });
    const log = readHostActionLog();
    expect(log.filter((entry) => entry.action === 'enroll')).toHaveLength(1);
  });

  test('the action log never records the join key', async () => {
    const minted = mintJoinKey();
    await enroll({ key: minted.key, machine_id: MEMBER_MACHINE });
    expect(JSON.stringify(readHostActionLog())).not.toContain(minted.key);
  });
});

/**
 * Single-use, across PROCESSES.
 *
 * Not testable in one process: `consumeJoinKey` is synchronous, so it cannot
 * interleave with itself there and an in-process race check passes whether or
 * not the store is locked. The race that matters is between daemons — the store
 * is under the machine-global team home, shared by every daemon on the box — so
 * this spawns two real ones.
 */
describe('join keys are single-use across processes', () => {
  test('two daemons spending the SAME key concurrently: exactly one wins', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-jk-race-'));
    const saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    try {
      const minted = mintJoinKey();
      const spender = path.join(import.meta.dir, '..', 'helpers', 'join-key-spender.ts');

      const spend = (worker: string) => new Promise<boolean>((resolve) => {
        const child = spawn(process.execPath, [spender, tmp, minted.key, worker], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += String(chunk); });
        child.on('close', () => {
          try { resolve((JSON.parse(out) as { ok: boolean }).ok === true); } catch { resolve(false); }
        });
      });

      const [a, b] = await Promise.all([spend('a'), spend('b')]);

      // Exactly one. Without the store lock this is both, ~96% of the time.
      expect([a, b].filter(Boolean)).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
      else process.env.MYCO_TEAM_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
