/**
 * Per-member tokens on the live team listener: revocation, machine-identity
 * binding, and the failed-auth throttle.
 *
 * Driven through a real `DaemonServer` over its real team socket, against the
 * REAL token store — nothing injected past the seam that touches disk, because
 * that seam is the revocation guarantee.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { HOST_PROTOCOL_VERSION } from '@myco/constants';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry';
import { issueMemberToken, listMembers, revokeMember } from '@myco/team-host/member-tokens';
import { createAuthThrottle } from '@myco/team-host/auth-throttle';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { teamFetch, teamSocketPath } from '../helpers/team-socket.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'the-shared-host-bearer-nobody-should-accept';
const MACHINE = 'alice_a1b2c3d4';

const describeTeamTransport = process.platform === 'win32' ? describe.skip : describe;

describeTeamTransport('per-member tokens on the team listener', () => {
  let tmp: string;
  let server: DaemonServer;
  let socketPath: string;
  let savedTeamHome: string | undefined;
  let savedMycoHome: string | undefined;
  let servedGrove: GroveRecord;
  let servedProjectId: string;
  let handlerCalls: number;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-tokens-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedMycoHome = process.env.MYCO_HOME;
    const mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = tmp;
    clearGroveRegistryCaches();

    // A real served Grove + tenancy, so a request that AUTHENTICATES also
    // reaches the handler — otherwise the served-grove filter 404s it and this
    // suite could not tell an auth failure from a tenancy refusal.
    servedGrove = createGrove('Served', mycoHome);
    servedProjectId = assertGroveProjectId(createProjectId());
    const servedRoot = path.join(tmp, 'served-project');
    fs.mkdirSync(servedRoot, { recursive: true });
    registerProjectInGrove(
      servedGrove.id,
      { projectId: servedProjectId, projectName: 'Served project', projectRoot: servedRoot },
      mycoHome,
    );

    handlerCalls = 0;
    socketPath = teamSocketPath('mt-host');
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      teamSocketPath: socketPath,
      hostServe: { bearer: HOST_BEARER, hostId: 'hostid-abc', label: 'host', servedGroveId: servedGrove.id },
      lockNamespace: testPerUserLockNamespace,
    });
    server.registerRoute('GET', '/api/sessions', async () => {
      handlerCalls += 1;
      return { body: { ok: true } };
    });
    await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const v = { 'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION) };
  const get = (token: string, extra: Record<string, string> = {}) =>
    teamFetch(socketPath, '/api/sessions', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...v,
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': servedProjectId,
        ...extra,
      },
    });

  test('the SHARED host bearer is no longer accepted', async () => {
    // Removing it is the point, not a side effect: every member holds a copy,
    // so leaving it accepted would make per-member revocation decorative.
    const res = await get(HOST_BEARER);
    expect(res.status).toBe(401);
    expect(handlerCalls).toBe(0);
  });

  test('a member token authenticates', async () => {
    const issued = issueMemberToken(MACHINE);
    const res = await get(issued.token);
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  test('REVOCATION is effective on the very next request — no restart', async () => {
    // The shared-bearer machinery read its secret once at startup, which is why
    // its own rotate function conceded a rotation "is inert until the daemon
    // restarts". The store is re-read per request precisely so this holds; a
    // cache here, however cheap, silently restores that defect.
    const issued = issueMemberToken(MACHINE);
    expect((await get(issued.token)).status).toBe(200);

    expect(revokeMember(issued.id)).toBe(true);

    // Same process, same listener, no restart.
    const after = await get(issued.token);
    expect(after.status).toBe(401);
    expect(handlerCalls).toBe(1);
  });

  test('revoking ONE member leaves another working', async () => {
    const alice = issueMemberToken('alice_a1b2c3d4');
    const bob = issueMemberToken('bob_99887766');

    revokeMember(alice.id);

    expect((await get(alice.token)).status).toBe(401);
    expect((await get(bob.token)).status).toBe(200);
  });

  test('a RE-JOIN replaces the machine\'s token — the old one stops working', async () => {
    // Two live tokens for one machine would mean revoking the row an operator
    // can see leaves an older credential working.
    const first = issueMemberToken(MACHINE);
    const second = issueMemberToken(MACHINE);

    expect((await get(second.token)).status).toBe(200);
    expect((await get(first.token)).status).toBe(401);
    expect(listMembers().filter((m) => m.machine_id === MACHINE)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Machine identity — TWO cases, because a single-case gate would certify the
  // silent overwrite as correct.
  // -------------------------------------------------------------------------

  test('ABSENT machine-id header → request proceeds under the TOKEN\'s identity', async () => {
    const issued = issueMemberToken(MACHINE);
    const res = await get(issued.token);
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  test('MISMATCHED machine-id header → 409, and the handler never runs', async () => {
    // Not a silent overwrite. `machine_id` regenerates when its cache file is
    // lost and can be baked wrong by the gh-timeout fallback, so overwriting
    // would attribute rows forever to an identity that no longer exists, with
    // no error anywhere. Divergence from the TOFU anchor is a re-join event.
    const issued = issueMemberToken(MACHINE);
    const res = await get(issued.token, { 'x-myco-machine-id': 'someone_else99' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('machine_identity_mismatch');
    expect(handlerCalls).toBe(0);
  });

  test('a MATCHING machine-id header is accepted', async () => {
    const issued = issueMemberToken(MACHINE);
    const res = await get(issued.token, { 'x-myco-machine-id': MACHINE });
    expect(res.status).toBe(200);
  });
});

describe('failed-auth throttle', () => {
  test('the first few failures are free, then the delay grows and is BOUNDED', async () => {
    let clock = 0;
    const throttle = createAuthThrottle(() => clock);

    const delays: number[] = [];
    for (let i = 0; i < 40; i += 1) delays.push(throttle.noteFailure());

    // A member retrying with a stale token a couple of times is not punished.
    expect(delays[0]).toBe(0);
    // It does eventually cost something.
    expect(delays[10]).toBeGreaterThan(0);
    // And it is capped — an unbounded backoff would be a denial of service an
    // anonymous caller could inflict on the team.
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_000);
  });

  test('SUCCESS clears the streak, so a working team never waits', async () => {
    let clock = 0;
    const throttle = createAuthThrottle(() => clock);
    for (let i = 0; i < 30; i += 1) throttle.noteFailure();
    expect(throttle.delayForFailure()).toBeGreaterThan(0);

    throttle.noteSuccess();

    expect(throttle.delayForFailure()).toBe(0);
  });

  test('failures age out, so a burst last week does not throttle today', async () => {
    let clock = 0;
    const throttle = createAuthThrottle(() => clock);
    for (let i = 0; i < 30; i += 1) throttle.noteFailure();
    expect(throttle.delayForFailure()).toBeGreaterThan(0);

    clock += 10 * 60_000;

    expect(throttle.delayForFailure()).toBe(0);
  });
});
