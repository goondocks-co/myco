/**
 * Team Host — registration-on-ingest through the REAL host dispatch (E-4 W2 T1a/c).
 *
 * Drives a real `DaemonServer` with a real overlay listener (the same shape as
 * `host-serve-grove-filter.test.ts`) serving ONE Grove that starts with NO
 * project registered. An overlay-marked COLLECT request carrying the served
 * grove + an UNKNOWN grove-era project must:
 *   1. register the project host-side (the pre-resolution seam), then
 *   2. resolve 2xx against that fresh row and let the handler write the served
 *      Grove DB (AC #1);
 *   3. the same for a transcript-drain-shaped push (AC #3, the C2 regression);
 * while a still-unregistered SERVE read (AC #5) and the foreign/null-grove
 * refusals (AC #8) stay 404 with zero registration side effect, and a request
 * still carrying `x-myco-project-root` (which the member proxy strips per T1b)
 * 404s — the C1 regression the strip fixes.
 *
 * Hermetic: MYCO_HOME / MYCO_TEAM_HOME are fresh tmpdirs per test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import type { HostServeRuntime } from '@myco/daemon/host-serve.js';
import { getDatabase, openReadonly } from '@myco/db/client.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import {
  createGrove,
  getRegisteredProjectInGrove,
  clearGroveRegistryCaches,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import type { RouteHandler } from '@myco/daemon/router.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-register-on-ingest-host-bearer';

/** Count sessions for a project id in a Grove DB, opened read-only. */
function sessionCount(dbPath: string, projectId: string): number {
  const db = openReadonly(dbPath);
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(projectId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('host registration-on-ingest (overlay integration)', () => {
  let tmp: string;
  let mycoHome: string;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let servedGrove: GroveRecord;
  let personalGrove: GroveRecord;
  let servers: DaemonServer[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-register-on-ingest-overlay-'));
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    clearGroveRegistryCaches();
    servers = [];
    // The served Grove starts with NO project registered — a freshly-attached
    // member's project is exactly this "unknown project" case.
    servedGrove = createGrove('Served', mycoHome);
    personalGrove = createGrove('Personal', mycoHome);
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const SERVE_READ_ROUTE = '/api/register-ingest-serve-probe';

  async function buildHostServer(servedGroveId: string | undefined): Promise<DaemonServer> {
    const hostServe: HostServeRuntime = {
      overlayAddress: '127.0.0.1',
      overlayPort: 0,
      bearer: HOST_BEARER,
      servedGroveId,
    };
    const hostVaultDir = path.join(tmp, 'host-anchor', '.myco');
    const logger = new DaemonLogger(path.join(tmp, 'host-logs'));
    const server = new DaemonServer({ vaultDir: hostVaultDir, logger, daemonStateAuthority: stubAuthority, hostServe });

    // Two collect-stamped handlers (real ROUTE_RULES stamps) that write a
    // session row in the resolved context and echo the resolved tenancy.
    const collectHandler: RouteHandler = async (req) => {
      const ctx = req.requestContext!;
      getDatabase()
        .prepare(`INSERT OR IGNORE INTO sessions (id, agent, project_id, started_at, created_at) VALUES (?, 'claude', ?, 0, 0)`)
        .run(`sess_${ctx.projectId}`, ctx.projectId);
      return { body: { ok: true, groveId: ctx.groveId, projectId: ctx.projectId } };
    };
    server.registerRoute('POST', '/sessions/register', collectHandler);
    server.registerRoute('POST', '/routed-capture/transcript', collectHandler);
    // A serve-stamped read probe (not in ROUTE_RULES → serve default) that the
    // registration seam never touches.
    server.registerRoute('GET', SERVE_READ_ROUTE, async (req) => ({
      body: { ok: true, groveId: req.requestContext?.groveId ?? null },
    }));

    await server.start(0);
    servers.push(server);
    return server;
  }

  function overlayHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${HOST_BEARER}`,
      [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
      ...extra,
    };
  }

  // -- AC #1 -----------------------------------------------------------------

  test('AC#1: a forwarded /sessions/register for an unknown project registers the row AND the session lands in the served Grove DB', async () => {
    const server = await buildHostServer(servedGrove.id);
    const projectId = assertGroveProjectId(createProjectId());

    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/sessions/register`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': projectId,
        'x-myco-machine-id': 'member-machine',
        'x-myco-session-id': 'sess-1',
      }),
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; groveId: string; projectId: string };
    expect(body.groveId).toBe(servedGrove.id);
    expect(body.projectId).toBe(projectId);

    clearGroveRegistryCaches();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, mycoHome)).not.toBeNull();
    expect(sessionCount(resolveGroveDbPath(servedGrove.id, mycoHome), projectId)).toBe(1);
  });

  // -- AC #3 -----------------------------------------------------------------

  test('AC#3: a transcript-drain-shaped push (tenancy headers) passes the served-grove filter and lands', async () => {
    const server = await buildHostServer(servedGrove.id);
    const projectId = assertGroveProjectId(createProjectId());

    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/routed-capture/transcript`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': projectId,
        'x-myco-machine-id': 'member-machine',
        'x-myco-session-id': 'sess-1',
      }),
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { groveId: string };
    expect(body.groveId).toBe(servedGrove.id);
    clearGroveRegistryCaches();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, mycoHome)).not.toBeNull();
  });

  // -- AC #2 / T1b: root header present → 404 (why the member proxy strips it) -

  test('T1b/C1: a forwarded collect STILL carrying x-myco-project-root registers but then 404s resolution — the regression the member-side strip fixes', async () => {
    const server = await buildHostServer(servedGrove.id);
    const projectId = assertGroveProjectId(createProjectId());

    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/sessions/register`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': projectId,
        // The member checkout path — absent on the host; feeds the root-equivalence
        // filter and misses the synthetic-root hosted row. Stripped at the member
        // hop (T1b) so it never actually arrives; here we prove the failure it
        // would cause if it did.
        'x-myco-project-root': '/Users/member/checkouts/some-project',
      }),
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown_tenancy');
    // Registration still ran pre-resolution (gate 6 probes without a root).
    clearGroveRegistryCaches();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, mycoHome)).not.toBeNull();
  });

  // -- AC #5 -----------------------------------------------------------------

  test('AC#5: a serve-stamped READ for a still-unregistered project stays 404 unknown_tenancy (the seam never registers on a read)', async () => {
    const server = await buildHostServer(servedGrove.id);
    const projectId = assertGroveProjectId(createProjectId());

    const res = await fetch(`http://127.0.0.1:${server.overlayPort}${SERVE_READ_ROUTE}`, {
      headers: overlayHeaders({
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': projectId,
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown_tenancy');
    clearGroveRegistryCaches();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, mycoHome)).toBeNull();
  });

  // -- AC #6 / #8: foreign (non-served) grove refused, zero registration ------

  test('AC#6/#8: a collect naming a NON-served grove is refused 404 with zero registration side effect', async () => {
    const server = await buildHostServer(servedGrove.id);
    const projectId = assertGroveProjectId(createProjectId());

    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/sessions/register`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-grove-id': personalGrove.id,
        'x-myco-project-id': projectId,
      }),
      body: '{}',
    });
    expect(res.status).toBe(404);
    clearGroveRegistryCaches();
    expect(getRegisteredProjectInGrove(personalGrove.id, projectId, mycoHome)).toBeNull();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, mycoHome)).toBeNull();
  });

  // -- AC #8: null grove refused ---------------------------------------------

  test('AC#8: a collect with NO grove header is refused 404 (null-grove branch), zero registration', async () => {
    const server = await buildHostServer(servedGrove.id);
    const projectId = assertGroveProjectId(createProjectId());

    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/sessions/register`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-project-id': projectId,
      }),
      body: '{}',
    });
    expect(res.status).toBe(404);
    clearGroveRegistryCaches();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, mycoHome)).toBeNull();
  });
});
