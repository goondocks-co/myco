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
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { assertGroveProjectId, createGroveId, createProjectId } from '@myco/grove/ids';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-host-serve-bearer-0123456789abcdef';

describe('Team Host transport-boundary gate (overlay listener)', () => {
  let tmp: string;
  let uiDir: string;
  let server: DaemonServer;
  let sessionsHandlerCalls: number;
  let mcpHandlerCalls: number;
  let shutdownCalls: number;
  let savedTeamHome: string | undefined;
  let loopback: string;
  let overlay: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-gate-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp; // empty attach registry — this daemon is the HOST

    // A minimal UI dir so we can prove the overlay refuses static/UI serving that
    // the loopback listener performs.
    uiDir = path.join(tmp, 'ui');
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><head></head><body>myco</body>');

    sessionsHandlerCalls = 0;
    mcpHandlerCalls = 0;
    shutdownCalls = 0;

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      uiDir,
      hostServe: { overlayAddress: '127.0.0.1', overlayPort: 0, bearer: HOST_BEARER },
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
    server.onShutdownRequest(() => { shutdownCalls += 1; });

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

  const bearer = (token = HOST_BEARER) => `Bearer ${token}`;
  const v1 = { 'x-myco-host-protocol': '1' };

  // --- blanket bearer: 401 on every route incl. raw + /mcp ---

  test('router route without the host bearer → 401, handler never runs', async () => {
    const res = await fetch(`${overlay}/api/sessions`, { headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('raw route (/health) without the host bearer → 401', async () => {
    const res = await fetch(`${overlay}/health`, { headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
  });

  test('/mcp without the host bearer → 401, /mcp handler never runs', async () => {
    const res = await fetch(`${overlay}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...v1 },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(mcpHandlerCalls).toBe(0);
  });

  test('wrong host bearer → 401', async () => {
    const res = await fetch(`${overlay}/api/sessions`, {
      headers: { Authorization: bearer('nope'), ...v1 },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('host_unauthorized');
    expect(sessionsHandlerCalls).toBe(0);
  });

  // --- correct bearer + version → served through the same dispatch ---

  test('correct bearer + version (no tenancy) → served locally, handler runs', async () => {
    const res = await fetch(`${overlay}/api/sessions`, {
      headers: { Authorization: bearer(), ...v1 },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('handler');
    expect(sessionsHandlerCalls).toBe(1);
  });

  test('correct bearer + version + /mcp → the raw /mcp handler runs', async () => {
    const res = await fetch(`${overlay}/mcp`, {
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
    const res = await fetch(`${overlay}/api/sessions`, {
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

  // --- version gate ---

  test('missing version header → 409 protocol_version_unsupported (both bounds + host header)', async () => {
    const res = await fetch(`${overlay}/api/sessions`, { headers: { Authorization: bearer() } });
    expect(res.status).toBe(409);
    expect(res.headers.get('x-myco-host-protocol')).toBe('1');
    const body = await res.json();
    expect(body.error).toBe('protocol_version_unsupported');
    expect(body.host_protocol_version).toBe(1);
    expect(body.host_min_compat_version).toBe(1);
    expect(sessionsHandlerCalls).toBe(0);
  });

  test('version above the window → 409 with both bounds', async () => {
    const res = await fetch(`${overlay}/api/sessions`, {
      headers: { Authorization: bearer(), 'x-myco-host-protocol': '2' },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('protocol_version_unsupported');
    expect(body.host_protocol_version).toBe(1);
    expect(body.host_min_compat_version).toBe(1);
  });

  test('version below the window → 409', async () => {
    const res = await fetch(`${overlay}/api/sessions`, {
      headers: { Authorization: bearer(), 'x-myco-host-protocol': '0' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('protocol_version_unsupported');
  });

  // --- /api/shutdown never overlay-served; works on localhost ---

  test('/api/shutdown over the overlay without bearer → 401, handler never fires', async () => {
    const res = await fetch(`${overlay}/api/shutdown`, { method: 'POST', headers: { ...v1 } });
    expect(res.status).toBe(401);
    expect(shutdownCalls).toBe(0);
  });

  test('/api/shutdown over the overlay WITH a valid bearer → 404 refused, handler never fires', async () => {
    const res = await fetch(`${overlay}/api/shutdown`, {
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

    const remote = await fetch(`${overlay}/`, { headers: { Authorization: bearer(), ...v1 } });
    expect(remote.status).toBe(404);
    expect((await remote.json()).error).toBe('not_found');
  });

  // --- bind address: never 0.0.0.0 ---

  test('the overlay listener binds the overlay IP, never 0.0.0.0', async () => {
    expect(server.overlayBoundAddress).toBe('127.0.0.1');
    expect(server.overlayBoundAddress).not.toBe('0.0.0.0');
    expect(server.overlayPort).toBeGreaterThan(0);
    expect(server.overlayPort).not.toBe(server.port);
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
  let savedTeamHome: string | undefined;
  let overlay: string;
  let loopback: string;

  // Per-route run counters — a REFUSED route's handler must never execute.
  let secretWriteCalls: number;
  let secretsListCalls: number;
  let gitStatusCalls: number;
  let sessionsCalls: number;
  let groveConfigWriteCalls: number;
  let scopedConfigWriteCalls: number;
  let shutdownCalls: number;
  let secretsFile: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-stamp-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp; // empty attach registry — this daemon is the HOST

    secretWriteCalls = 0;
    secretsListCalls = 0;
    gitStatusCalls = 0;
    sessionsCalls = 0;
    groveConfigWriteCalls = 0;
    scopedConfigWriteCalls = 0;
    shutdownCalls = 0;
    secretsFile = path.join(tmp, 'secrets.env');

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      hostServe: { overlayAddress: '127.0.0.1', overlayPort: 0, bearer: HOST_BEARER },
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
    server.onShutdownRequest(() => { shutdownCalls += 1; });

    await server.start(0);
    overlay = `http://127.0.0.1:${server.overlayPort}`;
    loopback = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${HOST_BEARER}`,
    'x-myco-host-protocol': '1',
    ...extra,
  });

  // --- THE Critical case: the provider-secret write is refused AND never written ---

  test('PUT /api/providers/secrets/:provider over the overlay → 404 refused; host secret NOT written', async () => {
    const res = await fetch(`${overlay}/api/providers/secrets/openai`, {
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
    const res = await fetch(`${overlay}/api/providers/secrets`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(secretsListCalls).toBe(0);
  });

  // --- degrade → capability-unavailable-hosted (same payload the member returns) ---

  test('a degrade route over the overlay → 409 capability_unavailable_hosted, handler never runs', async () => {
    const res = await fetch(`${overlay}/api/git/status`, { headers: authed() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('capability_unavailable_hosted');
    expect(body.capability).toBe('Git provenance');
    expect(gitStatusCalls).toBe(0);
  });

  // --- serve → STILL served (proves the backstop only ADDS refusals) ---

  test('a serve route over the overlay is STILL served locally (handler runs)', async () => {
    const res = await fetch(`${overlay}/api/sessions`, { headers: authed() });
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('handler');
    expect(sessionsCalls).toBe(1);
  });

  // --- config-lock → config-host-authoritative (same payload the member returns) ---

  test('a config-lock write over the overlay → 409 config_host_authoritative, handler never runs', async () => {
    const res = await fetch(`${overlay}/api/grove-config`, {
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
    const res = await fetch(`${overlay}/api/config/scoped`, {
      method: 'PUT',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ scope: 'machine', patch: { daemon: { log_level: 'debug' } } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
    expect(scopedConfigWriteCalls).toBe(0);
  });

  // --- existing exemptions intact (the backstop does not touch raw routes) ---

  test('/api/host/enroll over the overlay still works (bearer-exempt enrollment path intact)', async () => {
    const res = await fetch(`${overlay}/api/host/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-myco-host-protocol': '1' },
      body: JSON.stringify({ member_hostname: 'laptop', member_overlay_ip: '100.64.0.9' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bearer).toBe(HOST_BEARER);
  });

  test('/api/shutdown over the overlay still 404s and its handler never fires', async () => {
    const res = await fetch(`${overlay}/api/shutdown`, { method: 'POST', headers: authed() });
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

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-off-'));
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      // no hostServe → host serving off
    });
    server.registerRoute('GET', '/api/sessions', async () => ({ body: { ok: true } }));
    await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no overlay listener binds and the loopback listener works', async () => {
    expect(server.overlayPort).toBe(0);
    expect(server.overlayBoundAddress).toBeNull();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
    expect(res.status).toBe(200);
  });
});
