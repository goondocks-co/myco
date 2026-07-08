/**
 * Team Host enrollment endpoint (Task 2.4) — driven through a real `DaemonServer`
 * with a second overlay listener bound to `127.0.0.1` (the hermetic stand-in for a
 * 100.64/10 overlay IP; the gate logic is address-independent, same as the Task 2.3
 * transport-gate test).
 *
 * Proves the load-bearing security decisions:
 *   - enrollment works WITHOUT the host bearer over the overlay (the chicken-and-egg
 *     exemption) and returns the correct HostEnrollment;
 *   - the exemption is SURGICAL — a DIFFERENT overlay route still 401s without the
 *     bearer (the exemption did not widen the gate);
 *   - the route is OVERLAY-ONLY — a localhost hit 404s (overlay membership is the
 *     enrollment trust boundary);
 *   - the version gate STILL applies to enrollment (bearer-exempt ≠ version-exempt);
 *   - no operator control-plane route is registered on the daemon at all (a member
 *     cannot mint keys / evict over the overlay — those live only in the myco-team CLI);
 *   - each enrollment appends one `enroll` record to the control-plane action log.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { readHostActionLog } from '@myco/host/action-log';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-host-serve-bearer-0123456789abcdef';
const HOST_ID = 'hostid-abc123';
const HOST_LABEL = 'my-team-host';

describe('Team Host enrollment endpoint (/api/host/enroll)', () => {
  let tmp: string;
  let server: DaemonServer;
  let sessionsHandlerCalls: number;
  let savedTeamHome: string | undefined;
  let loopback: string;
  let overlay: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enroll-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp; // empty attach registry (this daemon is the HOST) + action-log home

    sessionsHandlerCalls = 0;
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      hostServe: { overlayAddress: '127.0.0.1', overlayPort: 0, bearer: HOST_BEARER, hostId: HOST_ID, label: HOST_LABEL },
    });
    // A different overlay route to prove the exemption did not widen the gate.
    server.registerRoute('GET', '/api/sessions', async () => {
      sessionsHandlerCalls += 1;
      return { body: { ok: true } };
    });
    await server.start(0);
    loopback = `http://127.0.0.1:${server.port}`;
    overlay = `http://127.0.0.1:${server.overlayPort}`;
  });

  afterEach(async () => {
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const v1 = { 'x-myco-host-protocol': '1' };
  const enrollHeaders = { 'Content-Type': 'application/json', ...v1 };
  const enrollBody = JSON.stringify({ member_hostname: 'a-member', member_overlay_ip: '100.64.0.9' });

  test('enrollment over the overlay WITHOUT a bearer → 200 with the correct HostEnrollment', async () => {
    const res = await fetch(`${overlay}/api/host/enroll`, { method: 'POST', headers: enrollHeaders, body: enrollBody });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bearer).toBe(HOST_BEARER);
    expect(body.overlay_address).toBe(`127.0.0.1:${server.overlayPort}`);
    expect(body.protocol_version).toBe(1);
    expect(body.host_id).toBe(HOST_ID);
    expect(body.label).toBe(HOST_LABEL);
    expect(body.projects).toEqual([]);
  });

  test('SURGICAL exemption: a DIFFERENT overlay route STILL 401s without the bearer', async () => {
    // Same missing-bearer request that enrollment tolerates must be refused elsewhere.
    const res = await fetch(`${overlay}/api/sessions`, { headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('OVERLAY-ONLY: enrollment on the localhost listener → 404 (overlay membership is the gate)', async () => {
    const res = await fetch(`${loopback}/api/host/enroll`, { method: 'POST', headers: enrollHeaders, body: enrollBody });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  test('the version gate STILL applies to enrollment (bearer-exempt is not version-exempt)', async () => {
    const res = await fetch(`${overlay}/api/host/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no x-myco-host-protocol
      body: enrollBody,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('protocol_version_unsupported');
  });

  test('a non-POST method on the enrollment route → 405', async () => {
    const res = await fetch(`${overlay}/api/host/enroll`, { headers: { ...v1 } });
    expect(res.status).toBe(405);
  });

  test('OPERATOR BOUNDARY: no control-plane route is registered — a key/devices path 404s over the overlay even WITH a valid bearer', async () => {
    // Key minting + device eviction live ONLY in the myco-team CLI (host localhost),
    // never as a daemon route. A member reaching the overlay listener therefore hits
    // nothing: any control-plane-shaped path 404s (the router has no such route).
    for (const p of ['/api/host/keys', '/api/host/devices', '/api/host/devices/evict']) {
      const res = await fetch(`${overlay}${p}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HOST_BEARER}`, ...enrollHeaders },
        body: '{}',
      });
      expect(res.status).toBe(404);
    }
  });

  test('enrollment appends one `enroll` record to the control-plane action log', async () => {
    await fetch(`${overlay}/api/host/enroll`, { method: 'POST', headers: enrollHeaders, body: enrollBody });
    const log = readHostActionLog(path.join(tmp, 'host'));
    const enrolls = log.filter((r) => r.action === 'enroll');
    expect(enrolls.length).toBe(1);
    // The member's overlay IP off the connection is the subject (127.0.0.1 in the
    // hermetic fixture); the self-reported hostname rides in detail. Never the bearer.
    expect(enrolls[0].detail?.member_hostname).toBe('a-member');
    expect(JSON.stringify(log)).not.toContain(HOST_BEARER);
  });
});
