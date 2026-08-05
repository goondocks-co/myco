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
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { readHostActionLog } from '@myco/host/action-log';
import { HOST_PROTOCOL_VERSION, HOST_PROXY_HEADERS_TIMEOUT_MS } from '@myco/constants';
import { mintJoinKey } from '@myco/team-host/join-keys';
import { authenticateMemberToken, listMembers, revokeMember } from '@myco/team-host/member-tokens';
import { realEnrollmentClient } from '@myco/host/member-overlay';
import { teamFetch, teamSocketPath } from '../helpers/team-socket.js';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';

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

  test('a member CANNOT evict another by asserting their machine_id', async () => {
    // The eviction this refuses: `machine_id` is self-asserted wire data, and
    // issuance replaces the record matching it. Silently replacing would hand
    // every invited member the operator's own revocation lever.
    const alice = await enroll({ key: mintJoinKey().key, machine_id: MEMBER_MACHINE });
    const aliceToken = ((await alice.json()) as { bearer: string }).bearer;

    const mallory = await enroll({
      key: mintJoinKey().key,
      machine_id: MEMBER_MACHINE,
      member_hostname: 'mallory-box',
    });

    expect(mallory.status).toBe(409);
    expect(((await mallory.json()) as { error: string }).error).toBe('machine_already_enrolled');
    // Alice still works, and the roster still shows HER.
    expect(authenticateMemberToken(aliceToken).ok).toBe(true);
    expect(listMembers()).toHaveLength(1);
    expect(listMembers()[0]?.label).not.toBe('mallory-box');
  });

  test('a malformed machine_id is refused, never stored', async () => {
    // Validated with the same rule the path resolvers enforce downstream, at
    // the boundary where it is first believed — it lands in the roster and the
    // action log long before it reaches a path.
    for (const machine_id of ['../escape', 'has/slash', 'has\nnewline', '.', '..', 'x'.repeat(200)]) {
      const res = await enroll({ key: mintJoinKey().key, machine_id });
      expect(res.status).toBe(401);
    }
    expect(listMembers()).toEqual([]);
  });

  test('NO ORACLE: without a valid key, "is this machine enrolled?" is unanswerable', async () => {
    // The already-enrolled refusal necessarily reveals whether a machine has
    // access. That answer must cost a valid unspent key — checked ahead of the
    // key it would answer anyone who can reach the public URL, which on a
    // Funnel is everyone.
    await enroll({ key: mintJoinKey().key, machine_id: MEMBER_MACHINE });

    // MEMBER_MACHINE is enrolled; 'nobody_00000000' is not. With a junk key,
    // both must answer identically — otherwise the difference IS the oracle.
    const enrolled = await enroll({ key: 'not-a-real-key', machine_id: MEMBER_MACHINE });
    const absent = await enroll({ key: 'not-a-real-key', machine_id: 'nobody_00000000' });

    expect(enrolled.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(await enrolled.json()).toEqual(await absent.json());
  });

  test('a refused collision does NOT spend the key', async () => {
    // The caller presented a valid key and did nothing wrong — the usual way
    // to reach this is re-joining a host that still holds a record for this
    // machine. Burning the invite would make them ask the operator twice.
    await enroll({ key: mintJoinKey().key, machine_id: MEMBER_MACHINE });

    const second = mintJoinKey();
    expect((await enroll({ key: second.key, machine_id: MEMBER_MACHINE })).status).toBe(409);

    // Once the incumbent is gone, that SAME key still works.
    const [incumbent] = listMembers();
    revokeMember(incumbent!.id);
    expect((await enroll({ key: second.key, machine_id: MEMBER_MACHINE })).status).toBe(200);
  });

  test('RESIGN: a member surrenders its OWN access, and only its own', async () => {
    // Without this, `myco leave` is a member-side write only: the host keeps a
    // live record forever and the next join is refused with no self-service
    // way out.
    const alice = await enroll({ key: mintJoinKey().key, machine_id: MEMBER_MACHINE });
    const aliceToken = ((await alice.json()) as { bearer: string }).bearer;
    const bob = await enroll({ key: mintJoinKey().key, machine_id: 'bob_99887766' });
    const bobToken = ((await bob.json()) as { bearer: string }).bearer;

    const res = await teamFetch(socketPath, '/api/host/resign', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json', ...v1 },
      body: '{}',
    });
    expect(res.status).toBe(200);

    expect(authenticateMemberToken(aliceToken).ok).toBe(false);
    // Bob is untouched — resigning is not a lever on anyone else.
    expect(authenticateMemberToken(bobToken).ok).toBe(true);
    // And the machine can now re-join, which is the whole point.
    expect((await enroll({ key: mintJoinKey().key, machine_id: MEMBER_MACHINE })).status).toBe(200);
  });

  test('RESIGN requires a token — it is NOT bearer-exempt like enrollment', async () => {
    await enroll({ key: mintJoinKey().key, machine_id: MEMBER_MACHINE });
    const res = await teamFetch(socketPath, '/api/host/resign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...v1 },
      body: '{}',
    });
    expect(res.status).toBe(401);
    // Nobody was revoked by an unauthenticated call.
    expect(listMembers().filter((m) => m.revoked)).toEqual([]);
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
 * The REAL transport, over a REAL TLS edge.
 *
 * Every other enrollment test injects an `EnrollmentTransport`, so the shipped
 * `defaultEnrollmentTransport` had zero coverage — and it did not work at all
 * under Bun, the runtime Myco ships. `req`'s `'close'` fires BEFORE the response
 * body's `'end'` there (Node fires it after), so the connection-lost backstop
 * rejected every enrollment the host had already answered 200. Nothing behind an
 * injected seam can see that; only the real `https.request` can.
 *
 * The 401 case is here for the same reason: it is a REFUSAL that must arrive as
 * a refusal, not as a transport error. Under the defect both looked identical.
 */
describeTeamTransport('enrollment over the real transport', () => {
  let tmp: string;
  let server: DaemonServer;
  let edge: FunnelEdge;
  let savedTeamHome: string | undefined;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enroll-real-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    const socketPath = teamSocketPath('enroll-real');
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      teamSocketPath: socketPath,
      hostServe: { bearer: HOST_BEARER, hostId: HOST_ID, label: HOST_LABEL },
      lockNamespace: testPerUserLockNamespace,
    });
    await server.start(0);
    edge = await startFunnelEdge(socketPath);
  });

  afterEach(async () => {
    await edge.close();
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ctx = (key: string) => ({
    hostId: HOST_ID,
    hostRef: HOST_ID,
    oneTimeKey: key,
    hostUrl: edge.url,
    machineId: MEMBER_MACHINE,
    memberHostname: 'alices-mac',
  });

  test('a real join RESOLVES and yields a working per-member token', async () => {
    const minted = mintJoinKey();
    const result = await realEnrollmentClient.enroll(ctx(minted.key));

    expect(result.host_id).toBe(HOST_ID);
    expect(result.bearer).not.toBe(HOST_BEARER);
    const auth = authenticateMemberToken(result.bearer);
    expect(auth.ok).toBe(true);
    expect(auth.ok && auth.machineId).toBe(MEMBER_MACHINE);
  });

  test('a refused join surfaces the REFUSAL, not a transport error', async () => {
    await expect(realEnrollmentClient.enroll(ctx('never-was-a-key')))
      .rejects.toThrow(/refused this join key/);
    expect(listMembers()).toEqual([]);
  });
});

/**
 * A join against a peer that STALLS mid-response must still settle.
 *
 * The shape: a complete status line and headers, a partial body, then the
 * socket held open. `'end'` never comes, `'aborted'` never fires, and `'close'`
 * is guarded by whether a response arrived — so the request's own deadline is
 * the last defence, and cancelling it when the response STARTS removed it at
 * exactly the wrong moment. That hung forever on Node as well as Bun, and a
 * hung `joinHost` never runs its own cleanup.
 *
 * Reached through the REAL TLS edge, because the edge forwards framing
 * verbatim: a stalled backend behind it is what a stalled Funnel backend or a
 * host wedged mid-response looks like from the member's side.
 */
describeTeamTransport('a stalled host does not hang the joiner', () => {
  test('headers, a partial body, then silence → the request still settles', async () => {
    const stalled = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '9999' });
      res.write('{"partial"');
      // ...and never ends. The socket stays open.
    });
    await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', () => r()));
    const backendPort = (stalled.address() as { port: number }).port;
    const edge = await startFunnelEdge({ port: backendPort });

    try {
      // Raced against an explicit watchdog rather than left to the runner's
      // own timeout: under the defect the request settles NEITHER way, which
      // wedges the process instead of failing the test — so a regression would
      // show up in CI as a hung job rather than a red one. This turns "never
      // settled" into a deterministic assertion failure.
      const outcome = await Promise.race([
        realEnrollmentClient.enroll({
          hostId: HOST_ID,
          hostRef: HOST_ID,
          oneTimeKey: 'irrelevant-the-peer-never-answers',
          hostUrl: edge.url,
          machineId: MEMBER_MACHINE,
        }).then(() => 'resolved', (e: Error) => `rejected: ${e.message}`),
        new Promise<string>((r) => {
          const t = setTimeout(() => r('NEVER SETTLED'), HOST_PROXY_HEADERS_TIMEOUT_MS + 5_000);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      expect(outcome).toMatch(/rejected: .*timed out/);
    } finally {
      // The stalled socket is still open by construction, and `close()` waits
      // for open connections — so force them down first or teardown hangs on
      // exactly the condition under test.
      stalled.closeAllConnections?.();
      await edge.close();
      await new Promise<void>((r) => stalled.close(() => r()));
    }
  }, 30_000);
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

      // Reports the child's EXIT too: a child that failed to start would
      // otherwise read as a clean refusal, and `[winner, crashed]` would
      // satisfy "exactly one" without the property ever being exercised.
      const spend = (worker: string) => new Promise<{ ok: boolean; exit: number | null }>((resolve) => {
        const child = spawn(process.execPath, [spender, tmp, minted.key, worker], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += String(chunk); });
        child.on('close', (exit) => {
          try { resolve({ ok: (JSON.parse(out) as { ok: boolean }).ok === true, exit }); }
          catch { resolve({ ok: false, exit: exit ?? -1 }); }
        });
      });

      const results = await Promise.all([spend('a'), spend('b')]);

      // BOTH children must have actually run and answered.
      expect(results.map((r) => r.exit)).toEqual([0, 0]);
      // Exactly one. Without the store lock this is both, ~96% of the time.
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
      else process.env.MYCO_TEAM_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
