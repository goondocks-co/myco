/**
 * Team Host — the HOST-side transport-boundary gate (Task 2.3), driven through a
 * real `DaemonServer` with a second overlay listener bound to `127.0.0.1` (the
 * stand-in for the host's 100.64/10 overlay IP — a hermetic test cannot attach a
 * real TUN interface; the gate logic is address-independent).
 *
 * Proves, at the actual listener:
 *   - EVERY overlay request without the host bearer → 401, on router routes, raw
 *     routes (/health), and /mcp;
 *   - a wrong bearer → 401; the correct bearer + a valid version → served through
 *     the SAME dispatch as localhost, with the local bearer stamped so tenancy
 *     resolution runs (a tenancy'd request reaches Grove resolution — 404
 *     unknown_tenancy — rather than 401, proving the stamp);
 *   - a missing or out-of-window `x-myco-host-protocol` → 409
 *     `protocol_version_unsupported` echoing BOTH bounds + the host version header;
 *   - `/api/shutdown` is refused over the overlay regardless of bearer (401 without,
 *     404 with) and its handler never fires — while localhost /api/shutdown works;
 *   - the overlay never serves the UI/static surface (404) though localhost does;
 *   - the listener binds the overlay IP, never 0.0.0.0;
 *   - the loopback listener is byte-identical (no bearer required, shutdown works);
 *   - with host-serve disabled, no second listener binds.
 *
 * Hermetic: fresh tmp home + `MYCO_TEAM_HOME`; the daemon state authority is
 * stubbed so no `daemon.json` is written; the host bearer is injected directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { teamFetch, teamSocketPath, removeSocket } from '../helpers/team-socket.js';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger, type LogEntry } from '@myco/daemon/logger';
import { __resetLogThrottleForTests, __setLogThrottleClockForTests } from '@myco/daemon/log-throttle';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { assertGroveProjectId, createGroveId, createProjectId } from '@myco/grove/ids';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry';
import { HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION, REFUSAL_LOG_THROTTLE_INTERVAL_MS } from '@myco/constants';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { issueTestMemberToken } from '../helpers/member-token.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-host-serve-bearer-0123456789abcdef';

let memberToken: string;

describe('Team Host transport-boundary gate (overlay listener)', () => {
  let tmp: string;
  let uiDir: string;
  let server: DaemonServer;
  let sessionsHandlerCalls: number;
  let mcpHandlerCalls: number;
  let shutdownCalls: number;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let loopback: string;
  let teamSock: string;
  let servedGrove: GroveRecord;
  let servedProjectId: string;
  let logEntries: LogEntry[];

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-gate-'));
    __resetLogThrottleForTests();
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    const mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = tmp; // empty attach registry — this daemon is the HOST
    // A REAL issued member token: the shared host bearer is no longer accepted,
    // so a fixture must hold a credential the host actually issued.
    memberToken = issueTestMemberToken();
    clearGroveRegistryCaches();

    // A real Grove this host is designated to serve — required since Task 2's
    // servedGroveRefusal fail-closed filter refuses every grove-resolving
    // overlay request unless it names THIS Grove.
    servedGrove = createGrove('Served', mycoHome);
    servedProjectId = assertGroveProjectId(createProjectId());
    const servedRoot = path.join(tmp, 'served-project');
    fs.mkdirSync(servedRoot, { recursive: true });
    registerProjectInGrove(
      servedGrove.id,
      { projectId: servedProjectId, projectName: 'Served project', projectRoot: servedRoot },
      mycoHome,
    );

    // A minimal UI dir so we can prove the overlay refuses static/UI serving that
    // the loopback listener performs.
    uiDir = path.join(tmp, 'ui');
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><head></head><body>myco</body>');

    sessionsHandlerCalls = 0;
    mcpHandlerCalls = 0;
    shutdownCalls = 0;

    logEntries = [];
    const logger = new DaemonLogger(path.join(tmp, 'logs'));
    logger.setPersistFn((entry) => logEntries.push(entry));

    teamSock = teamSocketPath();

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger,
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      uiDir,
      hostServe: { bearer: HOST_BEARER, servedGroveId: servedGrove.id },
      teamSocketPath: teamSock,
    });
    server.registerRoute('GET', '/api/sessions', async () => {
      sessionsHandlerCalls += 1;
      return { body: { ok: true, from: 'handler' } };
    });
    // Stand in for the raw /mcp route (registered as a raw route in production) so
    // we can prove the blanket bearer gate wraps raw routes including /mcp.
    server.registerRawRoute('/mcp', async (_req, res) => {
      mcpHandlerCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, from: 'mcp' }));
    });
    server.onShutdownRequest(async () => () => { shutdownCalls += 1; });

    await server.start(0);
    loopback = `http://127.0.0.1:${server.port}`;
    });

  afterEach(async () => {
    await server.stop();
    removeSocket(teamSock);
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    __resetLogThrottleForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Defaults to the suite's ISSUED member token; a caller passing an explicit
  // value is testing a WRONG credential on purpose.
  const bearer = (token?: string) => `Bearer ${token ?? memberToken}`;
  // A member speaking the CURRENT protocol. Pinned to the constant rather than
  // a literal: the version gate tests an inclusive window, so a hardcoded old
  // number silently converts every test in this file into a version-mismatch
  // test the moment the window moves.
  const v1 = { 'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION) };
  // The designated served Grove's tenancy headers — a real member request to a
  // grove-resolving route always carries these; Task 2's servedGroveRefusal
  // refuses any grove-resolving overlay request without them (or naming a
  // different Grove) at both dispatch chokepoints.
  const servedTenancy = () => ({
    'x-myco-grove-id': servedGrove.id,
    'x-myco-project-id': servedProjectId,
  });

  // --- overlay CSRF: no browsers on the overlay (runs before the bearer gate) ---

  test('a request carrying an Origin header → 403 forbidden_origin, handler never runs — direct browser access to the overlay stays refused', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: { Authorization: bearer(), ...v1, Origin: 'http://127.0.0.1:19666' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden_origin');
    expect(sessionsHandlerCalls).toBe(0);
  });

  // --- blanket bearer: 401 on every route incl. raw + /mcp ---

  test('router route without the host bearer → 401, handler never runs', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, { headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('raw route (/health) without the host bearer → 401', async () => {
    const res = await teamFetch(teamSock, `/health`, { headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
  });

  test('/mcp without the host bearer → 401, /mcp handler never runs', async () => {
    const res = await teamFetch(teamSock, `/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...v1 },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(mcpHandlerCalls).toBe(0);
  });

  test('wrong host bearer → 401', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: { Authorization: bearer('nope'), ...v1 },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(sessionsHandlerCalls).toBe(0);
  });

  // --- correct bearer + version → served through the same dispatch ---

  test('correct bearer + version + the designated served Grove\'s tenancy → served locally, handler runs', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: { Authorization: bearer(), ...v1, ...servedTenancy() },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('handler');
    expect(sessionsHandlerCalls).toBe(1);
  });

  test('correct bearer + version but NO tenancy at all → refused 404 by the served-grove filter (Task 2), handler never runs', async () => {
    // The bearer/lifecycle/version gate above (this describe block's subject)
    // passes a tenancy-less request through to dispatch exactly as before;
    // Task 2's servedGroveRefusal is what now refuses it, since the request
    // resolved no Grove at all. Full pass/refuse-by-designation coverage lives
    // in tests/daemon/host-serve-grove-filter.test.ts.
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: { Authorization: bearer(), ...v1 },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('correct bearer + version + /mcp → the raw /mcp handler runs', async () => {
    const res = await teamFetch(teamSock, `/mcp`, {
      method: 'POST',
      headers: { Authorization: bearer(), 'Content-Type': 'application/json', ...v1 },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('mcp');
    expect(mcpHandlerCalls).toBe(1);
  });

  test('correct bearer + version + tenancy headers → local-bearer stamp lets resolution run (404 unknown_tenancy, NOT 401)', async () => {
    // The member's proxy strips x-myco-auth; the gate stamps the local bearer after
    // admission so context-switching tenancy resolves. A non-existent Grove → 404
    // unknown_tenancy proves the request passed BOTH the host-bearer gate AND the
    // local context-switch auth (a failed stamp would be 401 unauthorized_context_switch).
    const projectId = assertGroveProjectId(createProjectId());
    const groveId = createGroveId();
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: {
        Authorization: bearer(),
        ...v1,
        'x-myco-project-id': projectId,
        'x-myco-grove-id': groveId,
      },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_tenancy');
    expect(sessionsHandlerCalls).toBe(0);
  });

  // --- Task 2 (E-4 W2): unknown-tenancy refusal observability ---

  test('overlay unknown-tenancy refusal logs one throttled warn with the expected fields; an identical repeat within the interval logs nothing more; once the interval elapses it logs again', async () => {
    // The throttle's own clock (not the runtime's system-time, which this
    // sandbox doesn't honor for direct Date.now() reads) is swapped so the
    // interval-elapsed branch is verifiable without a real 5-minute wait —
    // the pure mechanics are unit-tested in tests/daemon/log-throttle.test.ts;
    // this integration test only needs to prove the wiring at this call site.
    let fakeNow = 0;
    __setLogThrottleClockForTests(() => fakeNow);

    const projectId = assertGroveProjectId(createProjectId());
    const groveId = createGroveId();
    const headers = {
      Authorization: bearer(),
      ...v1,
      'x-myco-project-id': projectId,
      'x-myco-grove-id': groveId,
    };
    const refusalLogs = () => logEntries.filter((e) => e.kind === 'host.serve-refusal');

    const res1 = await teamFetch(teamSock, `/api/sessions`, { headers });
    expect(res1.status).toBe(404);
    const body1 = await res1.json();
    expect(body1.error).toBe('unknown_tenancy');
    expect(sessionsHandlerCalls).toBe(0);

    expect(refusalLogs()).toHaveLength(1);
    const [entry] = refusalLogs();
    expect(entry.level).toBe('warn');
    expect(entry.path).toBe('/api/sessions');
    expect(entry.grove_header).toBe(groveId);
    expect(entry.project_header).toBe(projectId);

    // An identical repeat within the throttle interval: response byte-identical
    // (Task 2 is log-lines-only, zero wire/behavior change), but no second log.
    const res2 = await teamFetch(teamSock, `/api/sessions`, { headers });
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual(body1);
    expect(refusalLogs()).toHaveLength(1);

    // Once the throttle interval fully elapses, the same refusal logs again.
    fakeNow += REFUSAL_LOG_THROTTLE_INTERVAL_MS + 1;
    const res3 = await teamFetch(teamSock, `/api/sessions`, { headers });
    expect(res3.status).toBe(404);
    expect(await res3.json()).toEqual(body1);
    expect(refusalLogs()).toHaveLength(2);
  });

  test('loopback unknown-tenancy refusal never logs (unchanged posture — a localhost caller sees the 404 body directly)', async () => {
    const projectId = assertGroveProjectId(createProjectId());
    const groveId = createGroveId();
    const res = await fetch(`${loopback}/api/sessions`, {
      headers: {
        'x-myco-auth': server.getAuthToken(),
        'x-myco-project-id': projectId,
        'x-myco-grove-id': groveId,
      },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_tenancy');
    expect(sessionsHandlerCalls).toBe(0);
    expect(logEntries.filter((e) => e.kind === 'host.serve-refusal')).toHaveLength(0);
  });

  // --- version gate ---

  test('missing version header → 409 protocol_version_unsupported (both bounds + host header)', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, { headers: { Authorization: bearer() } });
    expect(res.status).toBe(409);
    expect(res.headers.get('x-myco-host-protocol')).toBe(String(HOST_PROTOCOL_VERSION));
    const body = await res.json();
    expect(body.error).toBe('protocol_version_unsupported');
    expect(body.host_protocol_version).toBe(HOST_PROTOCOL_VERSION);
    expect(body.host_min_compat_version).toBe(HOST_MIN_COMPAT_VERSION);
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('version above the window → 409 with both bounds', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: { Authorization: bearer(), 'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION + 1) },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('protocol_version_unsupported');
    expect(body.host_protocol_version).toBe(HOST_PROTOCOL_VERSION);
    expect(body.host_min_compat_version).toBe(HOST_MIN_COMPAT_VERSION);
  });

  test('version below the window → 409', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, {
      headers: { Authorization: bearer(), 'x-myco-host-protocol': '0' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('protocol_version_unsupported');
  });

  // --- /api/shutdown never overlay-served; works on localhost ---

  test('/api/shutdown over the overlay without bearer → 401, handler never fires', async () => {
    const res = await teamFetch(teamSock, `/api/shutdown`, { method: 'POST', headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect(shutdownCalls).toBe(0);
  });

  test('/api/shutdown over the overlay WITH a valid bearer → 404 refused, handler never fires', async () => {
    const res = await teamFetch(teamSock, `/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: bearer(), ...v1 },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(shutdownCalls).toBe(0);
  });

  test('/api/shutdown on localhost still works (202) and fires the handler', async () => {
    const res = await fetch(`${loopback}/api/shutdown`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(shutdownCalls).toBe(1);
  });

  // --- the overlay serves only the daemon API, never the UI/static surface ---

  test('the UI/static surface is served on localhost but 404s over the overlay', async () => {
    const local = await fetch(`${loopback}/`);
    expect(local.status).toBe(200);
    expect(local.headers.get('content-type')).toContain('text/html');

    const remote = await teamFetch(teamSock, `/`, { headers: { Authorization: bearer(), ...v1 } });
    expect(remote.status).toBe(404);
    expect((await remote.json()).error).toBe('not_found');
  });

  // --- bind address: never 0.0.0.0 ---

  test('the team listener binds its socket — no TCP port, so nothing to reach it by', async () => {
    expect(server.teamSocketPath).toBe(teamSock);
    expect(fs.existsSync(teamSock)).toBe(true);
    // A socket has no port: the whole class of "some other local process holds
    // or reaches this port" is gone, which is why the Host allowlist could be.
    // Asserted as reachability, not as a field name — the socket's directory is
    // the boundary, so it must not be group/world accessible.
    expect(fs.lstatSync(path.dirname(teamSock)).mode & 0o077).toBe(0);
  });

  // --- loopback byte-identical ---

  test('the loopback listener is unchanged: no host bearer required', async () => {
    const sessions = await fetch(`${loopback}/api/sessions`);
    expect(sessions.status).toBe(200);
    expect((await sessions.json()).from).toBe('handler');
    expect(sessionsHandlerCalls).toBe(1);

    const health = await fetch(`${loopback}/health`);
    expect(health.status).toBe(200);
  });
});

describe('Team Host overlay stamp enforcement (host-side backstop)', () => {
  // The transport gate admits an overlay request (bearer + version); this backstop
  // then enforces the per-route scope-map stamp on the HOST so a member cannot
  // reach the routes the member-side classifier is supposed to keep off the overlay
  // (v1 flat-trust: the shared bearer proves admission, not identity — a hostile
  // member can craft a raw overlay request that never ran its own classifyRoute).
  let tmp: string;
  let server: DaemonServer;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let overlay: string;
  let loopback: string;
  let teamSock: string;
  let servedGrove: GroveRecord;
  let servedProjectId: string;

  // Per-route run counters — a REFUSED route's handler must never execute.
  let secretWriteCalls: number;
  let secretsListCalls: number;
  let gitStatusCalls: number;
  let sessionsCalls: number;
  let groveConfigWriteCalls: number;
  let scopedConfigWriteCalls: number;
  let shutdownCalls: number;
  let providersListCalls: number;
  let providerTestCalls: number;
  let dbVacuumCalls: number;
  let embeddingStatusCalls: number;
  let secretsFile: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-stamp-'));
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    const mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = tmp; // empty attach registry — this daemon is the HOST
    // A REAL issued member token: the shared host bearer is no longer accepted,
    // so a fixture must hold a credential the host actually issued.
    memberToken = issueTestMemberToken();
    clearGroveRegistryCaches();

    // A real Grove this host is designated to serve — required since Task 2's
    // servedGroveRefusal fail-closed filter refuses every grove-resolving
    // overlay request unless it names THIS Grove (the 'serve'-stamped routes
    // below, /api/sessions and /api/embedding/status, resolve tenancy).
    servedGrove = createGrove('Served', mycoHome);
    servedProjectId = assertGroveProjectId(createProjectId());
    const servedRoot = path.join(tmp, 'served-project');
    fs.mkdirSync(servedRoot, { recursive: true });
    registerProjectInGrove(
      servedGrove.id,
      { projectId: servedProjectId, projectName: 'Served project', projectRoot: servedRoot },
      mycoHome,
    );

    secretWriteCalls = 0;
    secretsListCalls = 0;
    gitStatusCalls = 0;
    sessionsCalls = 0;
    groveConfigWriteCalls = 0;
    scopedConfigWriteCalls = 0;
    shutdownCalls = 0;
    providersListCalls = 0;
    providerTestCalls = 0;
    dbVacuumCalls = 0;
    embeddingStatusCalls = 0;
    secretsFile = path.join(tmp, 'secrets.env');

    teamSock = teamSocketPath();

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      hostServe: { bearer: HOST_BEARER, servedGroveId: servedGrove.id },
      teamSocketPath: teamSock,
    });

    // localhost-only — THE credential-hijack moat. This handler is the only writer
    // of the host's provider secret; if the backstop stops it running, the host's
    // secret is never overwritten (the Critical case the gap allowed).
    server.registerRoute('PUT', '/api/providers/secrets/:provider', async ({ params }) => {
      secretWriteCalls += 1;
      fs.writeFileSync(secretsFile, `${(params as { provider: string }).provider}=stolen\n`);
      return { body: { ok: true } };
    });
    // localhost-only — machine-tier secret enumeration, never served to members.
    server.registerRoute('GET', '/api/providers/secrets', async () => {
      secretsListCalls += 1;
      return { body: { providers: ['openai'] } };
    });
    // degrade — capability off for hosted projects (git provenance).
    server.registerRoute('GET', '/api/git/status', async () => {
      gitStatusCalls += 1;
      return { body: { clean: true } };
    });
    // serve (default stamp) — MUST still be served over the overlay (no over-refusal).
    server.registerRoute('GET', '/api/sessions', async () => {
      sessionsCalls += 1;
      return { body: { ok: true, from: 'handler' } };
    });
    // config-lock — a write to host-authoritative shared config.
    server.registerRoute('PUT', '/api/grove-config', async () => {
      groveConfigWriteCalls += 1;
      return { body: { ok: true } };
    });
    // config-carve — member-ASSEMBLED config; the scoped write mutates host config.
    server.registerRoute('PUT', '/api/config/scoped', async () => {
      scopedConfigWriteCalls += 1;
      return { body: { ok: true } };
    });
    // localhost-only — provider connectivity; over the overlay a host key-validity
    // oracle + machine-config visibility. Must never run for an overlay caller.
    server.registerRoute('GET', '/api/providers', async () => {
      providersListCalls += 1;
      return { body: { providers: [{ type: 'openai', authConfigured: true }] } };
    });
    // localhost-only — the SSRF/reachability lever: the handler would dial a
    // member-supplied base_url. Proving it never runs proves the probe never fires.
    server.registerRoute('POST', '/api/providers/test', async () => {
      providerTestCalls += 1;
      return { body: { ok: true } };
    });
    // degrade — heavyweight Grove-DB maintenance; a member must not drive host vacuum.
    server.registerRoute('POST', '/api/database/vacuum', async () => {
      dbVacuumCalls += 1;
      return { body: { ok: true } };
    });
    // serve READ — embedding status stays served over the overlay (host vector state).
    server.registerRoute('GET', '/api/embedding/status', async () => {
      embeddingStatusCalls += 1;
      return { body: { ok: true, from: 'embedding-status' } };
    });
    server.onShutdownRequest(async () => () => { shutdownCalls += 1; });

    await server.start(0);
    loopback = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    removeSocket(teamSock);
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${memberToken}`,
    'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION),
    ...extra,
  });
  // The designated served Grove's tenancy — required on 'serve'-stamped routes
  // (/api/sessions, /api/embedding/status) now that Task 2's servedGroveRefusal
  // sits downstream of this describe block's route-stamp backstop.
  const servedTenancy = (): Record<string, string> => ({
    'x-myco-grove-id': servedGrove.id,
    'x-myco-project-id': servedProjectId,
  });

  // --- THE Critical case: the provider-secret write is refused AND never written ---

  test('PUT /api/providers/secrets/:provider over the overlay → 404 refused; host secret NOT written', async () => {
    const res = await teamFetch(teamSock, `/api/providers/secrets/openai`, {
      method: 'PUT',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ api_key: 'sk-attacker' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(secretWriteCalls).toBe(0);
    // The write side-effect never happened — the host's credentials are untouched.
    expect(fs.existsSync(secretsFile)).toBe(false);
  });

  test('the SAME provider-secret write on localhost still writes (the refusal is overlay-scoped, no over-block)', async () => {
    const res = await fetch(`${loopback}/api/providers/secrets/openai`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'sk-legit' }),
    });
    expect(res.status).toBe(200);
    expect(secretWriteCalls).toBe(1);
    expect(fs.existsSync(secretsFile)).toBe(true);
  });

  test('GET /api/providers/secrets over the overlay → 404 refused, handler never runs', async () => {
    const res = await teamFetch(teamSock, `/api/providers/secrets`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(secretsListCalls).toBe(0);
  });

  // --- degrade → capability-unavailable-hosted (same payload the member returns) ---

  test('a degrade route over the overlay → 409 capability_unavailable_hosted, handler never runs', async () => {
    const res = await teamFetch(teamSock, `/api/git/status`, { headers: authed() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('capability_unavailable_hosted');
    expect(body.capability).toBe('Git provenance');
    expect(gitStatusCalls).toBe(0);
  });

  // --- serve → STILL served (proves the backstop only ADDS refusals) ---

  test('a serve route over the overlay, with the designated served Grove\'s tenancy, is STILL served locally (handler runs)', async () => {
    const res = await teamFetch(teamSock, `/api/sessions`, { headers: { ...authed(), ...servedTenancy() } });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('handler');
    expect(sessionsCalls).toBe(1);
  });

  // --- config-lock → config-host-authoritative (same payload the member returns) ---

  test('a config-lock write over the overlay → 409 config_host_authoritative, handler never runs', async () => {
    const res = await teamFetch(teamSock, `/api/grove-config`, {
      method: 'PUT',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ config: { embedding: {} } }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('config_host_authoritative');
    expect(groveConfigWriteCalls).toBe(0);
  });

  // --- config-carve → 404 (member-assembled; the scoped write mutates host config) ---

  test('a config-carve scoped write over the overlay → 404 refused, host config NOT written', async () => {
    const res = await teamFetch(teamSock, `/api/config/scoped`, {
      method: 'PUT',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ scope: 'machine', patch: { daemon: { log_level: 'debug' } } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(scopedConfigWriteCalls).toBe(0);
  });

  // --- provider/model connectivity (the Major residual): machine-global, refused ---

  test('GET /api/providers over the overlay → 404 refused (host key-validity oracle closed), handler never runs', async () => {
    const res = await teamFetch(teamSock, `/api/providers`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(providersListCalls).toBe(0);
  });

  test('POST /api/providers/test over the overlay → 404 refused; the SSRF/reachability probe never fires', async () => {
    const res = await teamFetch(teamSock, `/api/providers/test`, {
      method: 'POST',
      headers: authed({ 'Content-Type': 'application/json' }),
      // A member-supplied base_url is the SSRF lever; the handler that would dial it never runs.
      body: JSON.stringify({ type: 'ollama', base_url: 'http://169.254.169.254/latest/meta-data' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(providerTestCalls).toBe(0);
  });

  // --- database/embedding sweep: maintenance mutation degrades, read still serves ---

  test('POST /api/database/vacuum over the overlay → 409 capability_unavailable_hosted, handler never runs', async () => {
    const res = await teamFetch(teamSock, `/api/database/vacuum`, { method: 'POST', headers: authed() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('capability_unavailable_hosted');
    expect(body.capability).toBe('Database maintenance');
    expect(dbVacuumCalls).toBe(0);
  });

  test('GET /api/embedding/status (a serve READ), with the designated served Grove\'s tenancy, over the overlay is STILL served (no over-refusal)', async () => {
    const res = await teamFetch(teamSock, `/api/embedding/status`, { headers: { ...authed(), ...servedTenancy() } });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('embedding-status');
    expect(embeddingStatusCalls).toBe(1);
  });

  // --- existing exemptions intact (the backstop does not touch raw routes) ---

  test('/api/host/enroll is team-admitted but hands out NOTHING without a valid key', async () => {
    // The route is token-EXEMPT — a member obtains its token here — so it is
    // admitted ONLY because it carries its own gate: a daemon-minted single-use
    // join key, validated in the request. Reaching it without one must yield a
    // credential-free refusal, and in particular must never echo the host's
    // shared bearer, which is what it used to return to any caller.
    const res = await teamFetch(teamSock, `/api/host/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION) },
      body: JSON.stringify({ member_hostname: 'laptop' }),
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(HOST_BEARER);
    expect(text).not.toContain('bearer"');
  });

  test('/api/shutdown over the overlay still 404s and its handler never fires', async () => {
    const res = await teamFetch(teamSock, `/api/shutdown`, { method: 'POST', headers: authed() });
    expect(res.status).toBe(404);
    expect(shutdownCalls).toBe(0);
  });

  test('the localhost listener is unchanged: a degrade route is served locally with no overlay refusal', async () => {
    const res = await fetch(`${loopback}/api/git/status`);
    expect(res.status).toBe(200);
    expect(gitStatusCalls).toBe(1);
  });
});

describe('Team Host serve disabled → no second listener', () => {
  let tmp: string;
  let server: DaemonServer;
  let teamSock: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-off-'));
    teamSock = teamSocketPath();
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      teamSocketPath: teamSock,
      // no hostServe → host serving off
    });
    server.registerRoute('GET', '/api/sessions', async () => ({ body: { ok: true } }));
    await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    removeSocket(teamSock);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no team listener binds and the loopback listener works', async () => {
    expect(server.teamSocketPath).toBeNull();
    expect(fs.existsSync(teamSock)).toBe(false);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
    expect(res.status).toBe(200);
  });
});
