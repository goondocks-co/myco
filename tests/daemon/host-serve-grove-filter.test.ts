/**
 * Team Host — the dual-homed served-grove fail-closed filter (Task 2).
 *
 * The overlay transport gate (CSRF -> bearer -> lifecycle -> version) admits
 * ANY bearer-holding member; it says nothing about WHICH Grove the member may
 * reach. `servedGroveRefusal` closes that gap: a member naming a Grove other
 * than the host's ONE designated `served_grove_id` (including the operator's
 * own personal Groves) must be refused, at BOTH overlay dispatch chokepoints —
 * router routes (`daemon/server.ts`) and the raw `/mcp` route (`mcp/http.ts`).
 *
 * The integration tests below drive a REAL `DaemonServer` with a REAL overlay
 * HTTP listener (the same shape as `tests/daemon/content-claims-overlay.test.ts`
 * and `tests/daemon/host-serve-config.test.ts`) — never a mock of the filter
 * itself — so a regression in either chokepoint's wiring (not just the pure
 * `servedGroveRefusal` predicate) fails this suite.
 *
 * Hermetic: `MYCO_HOME` / `MYCO_TEAM_HOME` are fresh tmpdirs per test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import { servedGroveRefusal, type HostServeRuntime } from '@myco/daemon/host-serve.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { vi } from '../helpers/vi-shim.js';

// ---------------------------------------------------------------------------
// Pure predicate — fast, isolated coverage of every servedGroveRefusal branch.
// ---------------------------------------------------------------------------

function runtime(servedGroveId?: string): HostServeRuntime {
  return { overlayAddress: '127.0.0.1', bearer: 'test-bearer', servedGroveId };
}

describe('servedGroveRefusal (pure)', () => {
  test('no designation (!runtime.servedGroveId) -> refuses regardless of resolved grove', () => {
    expect(servedGroveRefusal(runtime(undefined), 'grove_x')).not.toBeNull();
    expect(servedGroveRefusal(runtime(undefined), null)).not.toBeNull();
  });

  test('resolved context has no grove -> refuses (explicit null branch, never fails open)', () => {
    const refusal = servedGroveRefusal(runtime('grove_served'), null);
    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(404);
  });

  test('resolved grove does not match the served designation -> refuses', () => {
    const refusal = servedGroveRefusal(runtime('grove_served'), 'grove_other');
    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(404);
  });

  test('resolved grove is the exact served designation -> passes (null)', () => {
    expect(servedGroveRefusal(runtime('grove_served'), 'grove_served')).toBeNull();
  });

  test('every refusal is 404-shaped with an error code, matching the existing lifecycle-refusal posture', () => {
    for (const refusal of [
      servedGroveRefusal(runtime(undefined), 'grove_x'),
      servedGroveRefusal(runtime('grove_served'), null),
      servedGroveRefusal(runtime('grove_served'), 'grove_other'),
    ]) {
      expect(refusal?.status).toBe(404);
      expect(refusal?.body.error).toBe('not_found');
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — a real DaemonServer, a real overlay listener, two real Groves.
// ---------------------------------------------------------------------------

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-served-grove-filter-host-bearer';

function mockDaemonClient(): DaemonClient {
  return {
    get: vi.fn(async () => ({ ok: true, data: {} })),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

describe('dual-homed served-grove fail-closed filter (overlay integration)', () => {
  let tmp: string;
  let mycoHome: string;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let servedGrove: GroveRecord;
  let servedProjectId: string;
  let personalGrove: GroveRecord;
  let personalProjectId: string;
  let servers: DaemonServer[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-served-grove-filter-'));
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    clearGroveRegistryCaches();
    servers = [];

    // Two real Groves the host owns: the ONE it is designated to serve, and a
    // second "personal" Grove that stands in for the operator's own unrelated
    // work — exactly the Grove a bearer-holding member must never reach.
    servedGrove = createGrove('Served', mycoHome);
    servedProjectId = assertGroveProjectId(createProjectId());
    const servedRoot = path.join(tmp, 'served-project');
    fs.mkdirSync(servedRoot, { recursive: true });
    registerProjectInGrove(
      servedGrove.id,
      { projectId: servedProjectId, projectName: 'Served project', projectRoot: servedRoot },
      mycoHome,
    );

    personalGrove = createGrove('Personal', mycoHome);
    personalProjectId = assertGroveProjectId(createProjectId());
    const personalRoot = path.join(tmp, 'personal-project');
    fs.mkdirSync(personalRoot, { recursive: true });
    registerProjectInGrove(
      personalGrove.id,
      { projectId: personalProjectId, projectName: 'Personal project', projectRoot: personalRoot },
      mycoHome,
    );
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A router-route path that is NOT in `host/routing.ts`'s `ROUTE_RULES` (a
  // static scan of `packages/myco/src` — this test file is outside that
  // scan), so it takes the documented `serve` DEFAULT stamp and is never
  // itself refused by the unrelated route-stamp backstop
  // (`overlayHostStampRefusal`). `/ready` was tried first and rejected as a
  // fixture route: it is explicitly stamped `localhost-only`
  // (`routing.ts:333`), so it 404s over the overlay for a reason that has
  // nothing to do with Grove designation — it would make every router-route
  // case in this suite pass or fail for the WRONG reason.
  const PROBE_ROUTE = '/api/served-grove-filter-probe';

  /**
   * A real DaemonServer with a real overlay listener AND the real `/mcp` raw
   * route wired exactly as `daemon/main.ts` wires it (chokepoint 2) — the
   * `hostServe` runtime is threaded into BOTH the server construction
   * (chokepoint 1) and `createStreamableMcpHttpHandler` (chokepoint 2). Also
   * registers `PROBE_ROUTE`, a minimal `serve`-stamped router route that
   * echoes the resolved `groveId`, standing in for the ~80 real
   * knowledge-serving router routes chokepoint 1 protects.
   */
  async function buildHostServer(servedGroveId: string | undefined): Promise<DaemonServer> {
    const hostServe: HostServeRuntime = {
      overlayAddress: '127.0.0.1',
      overlayPort: 0,
      bearer: HOST_BEARER,
      servedGroveId,
    };
    const hostVaultDir = path.join(tmp, 'host-anchor', '.myco');
    const logger = new DaemonLogger(path.join(tmp, 'host-logs'));
    const server = new DaemonServer({
      vaultDir: hostVaultDir,
      logger,
      daemonStateAuthority: stubAuthority,
      hostServe,
    });
    server.registerRoute('GET', PROBE_ROUTE, async (req) => ({
      body: { ok: true, groveId: req.requestContext?.groveId ?? null },
    }));
    server.registerRawRoute('/mcp', createStreamableMcpHttpHandler(hostVaultDir, {
      client: mockDaemonClient(),
      hostServe,
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

  // -- (a) router route: foreign (personal) Grove refused -------------------

  test('(a) router route: a bearer-holding member naming the operator\'s personal Grove is refused 404', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}${PROBE_ROUTE}`, {
      headers: overlayHeaders({
        'x-myco-grove-id': personalGrove.id,
        'x-myco-project-id': personalProjectId,
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  // -- (b) /mcp: foreign (personal) Grove refused ----------------------------

  test('(b) /mcp: a bearer-holding member naming the personal Grove is refused 404 before any tools/list dispatch', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/mcp`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-grove-id': personalGrove.id,
        'x-myco-project-id': personalProjectId,
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  // -- (c) no grove header -> the null branch closes, both chokepoints ------

  test('(c) router route: no grove header resolves a null Grove and is refused (null branch closed, not fail-open)', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}${PROBE_ROUTE}`, {
      headers: overlayHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('(c) /mcp: a caller-tenancy request with no grove id resolves a null Grove and is refused (null branch closed, not fail-open)', async () => {
    // A project-id-only header (no x-myco-grove-id) is exactly the shape the
    // spec forbids fail-open on: `resolveRequestContextOrLegacy` resolves this
    // as tenancySource 'caller' (so it is NOT intercepted by the unrelated
    // legacy_vault soft-fail gate) yet groveId stays null — the resolved-
    // context-has-no-grove branch, not the no-designation branch.
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/mcp`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-project-id': servedProjectId,
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  // -- (d) the designated served Grove passes, both chokepoints -------------

  test('(d) router route: the designated served Grove passes through to the real handler', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}${PROBE_ROUTE}`, {
      headers: overlayHeaders({
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': servedProjectId,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; groveId: string | null };
    expect(body.ok).toBe(true);
    expect(body.groveId).toBe(servedGrove.id);
  });

  test('(d) /mcp: the designated served Grove reaches real MCP dispatch (tools/list succeeds)', async () => {
    const server = await buildHostServer(servedGrove.id);
    const client = new Client({ name: 'served-grove-filter-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.overlayPort}/mcp`),
      {
        requestInit: {
          headers: overlayHeaders({
            'x-myco-grove-id': servedGrove.id,
            'x-myco-project-id': servedProjectId,
          }),
        },
      },
    );
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain('myco_cortex');
    await client.close();
  });

  // -- (e) loopback requests are entirely unaffected -------------------------

  test('(e) loopback requests are entirely unaffected by the overlay filter', async () => {
    const server = await buildHostServer(servedGrove.id);

    const bare = await fetch(`http://127.0.0.1:${server.port}${PROBE_ROUTE}`);
    expect(bare.status).toBe(200);

    // The operator's own local admin surface must reach the "personal" Grove
    // freely from loopback — this filter is scoped to isOverlayRequest(req)
    // and must never leak into the non-overlay local dispatch path.
    const withPersonalGrove = await fetch(`http://127.0.0.1:${server.port}${PROBE_ROUTE}`, {
      headers: {
        'x-myco-grove-id': personalGrove.id,
        'x-myco-project-id': personalProjectId,
        'x-myco-auth': server.getAuthToken(),
      },
    });
    expect(withPersonalGrove.status).toBe(200);
    const body = await withPersonalGrove.json() as { groveId: string | null };
    expect(body.groveId).toBe(personalGrove.id);
  });

  // -- (f) enabled && !served_grove_id -> refuses everything, both chokepoints

  test('(f) no served_grove_id designation: every grove-resolving overlay router request is refused', async () => {
    const server = await buildHostServer(undefined);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}${PROBE_ROUTE}`, {
      headers: overlayHeaders({
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': servedProjectId,
      }),
    });
    expect(res.status).toBe(404);
  });

  test('(f) no served_grove_id designation: every grove-resolving overlay /mcp request is refused', async () => {
    const server = await buildHostServer(undefined);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/mcp`, {
      method: 'POST',
      headers: overlayHeaders({
        'content-type': 'application/json',
        'x-myco-grove-id': servedGrove.id,
        'x-myco-project-id': servedProjectId,
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
  });
});
