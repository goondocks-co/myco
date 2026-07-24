/**
 * Chokepoint 1 (router dispatch) integration for the Team Host attach
 * short-circuit + host proxy — driven through a real `DaemonServer` over
 * loopback HTTP, forwarding to a real fixture "host" server.
 *
 * Proves, at the actual dispatch site:
 *   - an attached project + `serve` route is proxied to the host (the fixture
 *     receives it with the host bearer + version header, the local x-myco-auth
 *     stripped), the route handler never runs, and no local Grove DB is opened;
 *   - an attached project + `degrade` route returns the uniform refusal (409
 *     `capability_unavailable_hosted`), handler never runs, no DB opened;
 *   - a URL-tenancy resource route asserts the daemon bearer BEFORE any proxy
 *     dial (401 on a bad bearer; proxied on a good one) — the URL-route
 *     auth-before-proxy gate;
 *   - a non-attached request is byte-identical to today — it reaches the handler.
 *
 * Hermetic: `MYCO_TEAM_HOME` (attach registry) and the daemon log dir are fresh
 * tmpdirs; the daemon state authority is stubbed so no `daemon.json` is written.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '@myco/grove/ids';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);

interface HostHit { method: string; url: string; headers: http.IncomingHttpHeaders; }

describe('attach short-circuit at router dispatch (chokepoint 1)', () => {
  let tmp: string;
  let server: DaemonServer;
  let runtimeCache: GroveRuntimeCache;
  let dbOpens: number;
  let sessionsHandlerCalls: number;
  let gitHandlerCalls: number;
  let archiveHandlerCalls: number;
  let blobHandlerCalls: number;
  let savedTeamHome: string | undefined;
  let savedAuth: string | undefined;
  let base: string;
  let authToken: string;
  let hostServer: http.Server;
  let hostHits: HostHit[];
  let overlayAddress: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dispatch-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedAuth = process.env.MYCO_DAEMON_AUTH;
    process.env.MYCO_TEAM_HOME = tmp;

    // Fixture "host": records what it receives, replies 200.
    hostHits = [];
    hostServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hostHits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, from: 'host' }));
      });
    });
    const hostPort = await new Promise<number>((resolve) =>
      hostServer.listen(0, '127.0.0.1', () => resolve((hostServer.address() as AddressInfo).port)));
    overlayAddress = `127.0.0.1:${hostPort}`;

    dbOpens = 0;
    sessionsHandlerCalls = 0;
    gitHandlerCalls = 0;
    archiveHandlerCalls = 0;
    blobHandlerCalls = 0;
    runtimeCache = new GroveRuntimeCache();
    const origGetDatabase = runtimeCache.getDatabase.bind(runtimeCache);
    (runtimeCache as unknown as { getDatabase: (p: string) => unknown }).getDatabase = (p: string) => {
      dbOpens += 1;
      return origGetDatabase(p);
    };

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      runtimeCache,
    });
    server.registerRoute('GET', '/api/sessions', async () => {
      sessionsHandlerCalls += 1;
      return { body: { ok: true } };
    });
    server.registerRoute('GET', '/api/git/status', async () => {
      gitHandlerCalls += 1;
      return { body: { ok: true } };
    });
    // Grove-lifecycle route: grove param is named `:id`, project is `:projectId`.
    server.registerRoute('POST', '/api/groves/:id/projects/:projectId/archive', async () => {
      archiveHandlerCalls += 1;
      return { body: { ok: true } };
    });
    // URL-tenancy resource route: grove + project in the path (defaults to serve).
    server.registerRoute('GET', '/api/g/:groveId/p/:projectId/blob', async () => {
      blobHandlerCalls += 1;
      return { body: { ok: true } };
    });

    await server.start(0);
    base = `http://127.0.0.1:${server.port}`;
    authToken = server.getAuthToken();
  });

  afterEach(async () => {
    await server.stop();
    (hostServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedAuth === undefined) delete process.env.MYCO_DAEMON_AUTH;
    else process.env.MYCO_DAEMON_AUTH = savedAuth;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function attach(): { projectId: string; groveId: string } {
    const projectId = assertGroveProjectId(createProjectId());
    const groveId = createGroveId();
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      overlay_address: overlayAddress,
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: groveId, project_id: projectId }],
    };
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');
    return { projectId, groveId };
  }

  test('attached + serve route → proxied to host, handler never runs, no DB opened', async () => {
    const { projectId } = attach();
    const res = await fetch(`${base}/api/sessions`, {
      headers: { 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('host');
    // The request reached the host with the host bearer + version header, and
    // the LOCAL bearer stripped.
    expect(hostHits).toHaveLength(1);
    expect(hostHits[0].url).toBe('/api/sessions');
    expect(hostHits[0].headers['x-myco-project-id']).toBe(projectId);
    expect(hostHits[0].headers['x-myco-auth']).toBeUndefined();
    expect(hostHits[0].headers.authorization).toBe('Bearer host-bearer');
    expect(hostHits[0].headers['x-myco-host-protocol']).toBe(String(HOST_PROTOCOL_VERSION));
    // Local handler never ran; no local Grove DB opened.
    expect(sessionsHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
  });

  test('attached + degrade route → uniform refusal (409), handler never runs, no DB opened', async () => {
    const { projectId } = attach();
    const res = await fetch(`${base}/api/git/status`, {
      headers: { 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('capability_unavailable_hosted');
    expect(body.capability).toBe('Git provenance');
    expect(gitHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
    expect(hostHits).toHaveLength(0);
  });

  test('non-attached request is byte-identical: it reaches the route handler', async () => {
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sessionsHandlerCalls).toBe(1);
    expect(hostHits).toHaveLength(0);
  });

  test('attach classification from the URL project param alone (no header) → degrade', async () => {
    // The grove-lifecycle route names the grove param `:id`, so the project is
    // recognized purely from the URL `:projectId` — no x-myco-project-id header.
    const { projectId } = attach();
    const res = await fetch(
      `${base}/api/groves/grove_0123456789abcdef0123456789abcdef/projects/${projectId}/archive`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('capability_unavailable_hosted');
    expect(body.capability).toBe('Grove administration');
    expect(archiveHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
  });

  test('URL-tenancy resource route on an attached project: bad bearer → 401 BEFORE any proxy dial', async () => {
    const { projectId, groveId } = attach();
    const res = await fetch(`${base}/api/g/${groveId}/p/${projectId}/blob`, {
      headers: { 'x-myco-auth': 'wrong-bearer' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized_context_switch');
    // Never dialed the host, never ran the handler, never opened a DB.
    expect(hostHits).toHaveLength(0);
    expect(blobHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
  });

  test('URL-tenancy resource route on an attached project: good bearer → proxied to host', async () => {
    const { projectId, groveId } = attach();
    const res = await fetch(`${base}/api/g/${groveId}/p/${projectId}/blob`, {
      headers: { 'x-myco-auth': authToken },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('host');
    expect(hostHits).toHaveLength(1);
    expect(hostHits[0].url).toBe(`/api/g/${groveId}/p/${projectId}/blob`);
    expect(blobHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
  });

  test('auth runs before the body read: oversized body + wrong bearer → 401, not 413', async () => {
    // Ordering change vs today (chosen, not accidental): the pre-parse runs the
    // context-switch bearer gate BEFORE readBody, so an unauthorized write with
    // an over-limit body is rejected 401 rather than 413. The handler never runs.
    server.registerRoute('POST', '/api/test-write', async () => ({ body: { ok: true } }));
    const unattached = createProjectId();
    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1024);
    const res = await fetch(`${base}/api/test-write`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-project-id': unattached,
        'x-myco-auth': 'wrong-bearer',
      },
      body: oversized,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized_context_switch');
  });
});
