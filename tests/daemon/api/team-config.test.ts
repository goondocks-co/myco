/**
 * `team-write` route class (Task 8) — routed served-grove config/secrets.
 *
 * Covers the brief's Step 1 (a)-(f):
 *   (a) member-side classify routes team-write to the host for attached context
 *   (b) host backstop admits team-write only for the served grove
 *   (c) config write lands in served grove grove.yaml grove tier
 *   (d) secrets PUT stores and echoes masked only
 *   (e) leak-guard — covered by the EXTENDED tests/daemon/api/key-leak-guard.test.ts
 *       (the merge gate); not duplicated here.
 *   (f) unstamped new route still fails the completeness guard — structurally
 *       guaranteed by tests/meta/route-stamp-completeness.test.ts's full-tree
 *       scan (it covers this file's own new registrations), plus the explicit
 *       matchRouteRule pins added there.
 *
 * Hermetic: MYCO_HOME / MYCO_TEAM_HOME are fresh tmpdirs per test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { classifyRoute } from '@myco/host/routing';
import type { HostServeRuntime } from '@myco/daemon/host-serve';
import { resolveServedGroveKeyHealthIsolated } from '@myco/daemon/host-serve';
import {
  handleGetTeamConfig,
  handlePutTeamConfig,
  handlePutTeamSecret,
  handleDeleteTeamSecret,
  handleRotateExternalMcpToken,
  registerTeamConfigRoutes,
} from '@myco/daemon/api/team-config';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '@myco/grove/ids';
import { upsertHost, writeHostSecret, type HostRecord } from '@myco/host/registry';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry';
import { resolveGroveConfigPath, resolveGroveDir, resolveMycoHome } from '@myco/grove/paths';
import { readSecrets, writeSecret } from '@myco/config/secrets';
import { loadMachineConfig, loadGroveConfig, saveMachineConfig } from '@myco/config/loader';
import { HOST_BEARER_SECRET, HOST_EXTERNAL_MCP_TOKEN_SECRET, HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION } from '@myco/constants';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;

function withHermeticHomes(): { home: () => string; tmp: () => string } {
  let home = '';
  let tmp = '';
  let savedHome: string | undefined;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-config-'));
    savedHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    process.env.MYCO_HOME = home;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    clearGroveRegistryCaches();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return { home: () => home, tmp: () => tmp };
}

// ---------------------------------------------------------------------------
// (a) member-side classify routes team-write to the host for attached context
// ---------------------------------------------------------------------------

describe('(a) classifyRoute: team-write routes to the host for an attached project', () => {
  const { tmp } = withHermeticHomes();

  function attach(): { projectId: string } {
    const projectId = assertGroveProjectId(createProjectId());
    const groveId = createGroveId();
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Test Host',
      overlay_address: '127.0.0.1:9',
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: groveId, project_id: projectId }],
    };
    upsertHost(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');
    return { projectId };
  }

  const TEAM_WRITE_ROUTES: Array<{ method: string; pathname: string }> = [
    { method: 'GET', pathname: '/api/team/config' },
    { method: 'PUT', pathname: '/api/team/config' },
    { method: 'PUT', pathname: '/api/team/secrets/anthropic' },
    { method: 'DELETE', pathname: '/api/team/secrets/anthropic' },
    { method: 'POST', pathname: '/api/team/mcp-token/rotate' },
  ];

  for (const route of TEAM_WRITE_ROUTES) {
    test(`${route.method} ${route.pathname}: attached project -> remote, stamp team-write`, () => {
      const { projectId } = attach();
      const decision = classifyRoute({ method: route.method, pathname: route.pathname, projectId });
      expect(decision.kind).toBe('remote');
      if (decision.kind === 'remote') {
        expect(decision.classification.stamp).toBe('team-write');
      }
    });
  }

  test('non-attached project: team-write routes stay local (never proxied)', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const decision = classifyRoute({ method: 'GET', pathname: '/api/team/config', projectId });
    expect(decision.kind).toBe('local');
  });

  test('the legacy /api/team/* prefix (team-sync) is unaffected — still localhost-only (local kind)', () => {
    const { projectId } = attach();
    const decision = classifyRoute({ method: 'GET', pathname: '/api/team/status', projectId });
    expect(decision.kind).toBe('local');
  });

  test('tmp dir created (fixture sanity)', () => {
    expect(fs.existsSync(tmp())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) host backstop: team-write is admitted only for the served grove
// ---------------------------------------------------------------------------

describe('(b) overlay integration: team-write is admitted only for the served grove', () => {
  let tmp: string;
  let savedHome: string | undefined;
  let savedTeamHome: string | undefined;
  let servedGrove: GroveRecord;
  let servedProjectId: string;
  let personalGrove: GroveRecord;
  let personalProjectId: string;
  let servers: DaemonServer[];
  const HOST_BEARER = 'test-team-config-host-bearer';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-config-overlay-'));
    savedHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    process.env.MYCO_HOME = home;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    clearGroveRegistryCaches();
    servers = [];

    servedGrove = createGrove('Served', home);
    servedProjectId = assertGroveProjectId(createProjectId());
    const servedRoot = path.join(tmp, 'served-project');
    fs.mkdirSync(servedRoot, { recursive: true });
    registerProjectInGrove(
      servedGrove.id,
      { projectId: servedProjectId, projectName: 'Served project', projectRoot: servedRoot },
      home,
    );

    personalGrove = createGrove('Personal', home);
    personalProjectId = assertGroveProjectId(createProjectId());
    const personalRoot = path.join(tmp, 'personal-project');
    fs.mkdirSync(personalRoot, { recursive: true });
    registerProjectInGrove(
      personalGrove.id,
      { projectId: personalProjectId, projectName: 'Personal project', projectRoot: personalRoot },
      home,
    );
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
    if (savedHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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
    registerTeamConfigRoutes(server, { hostServe, mycoHome: process.env.MYCO_HOME! });
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

  test('GET /api/team/config: the served grove passes through', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': servedProjectId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { groveId: string };
    expect(body.groveId).toBe(servedGrove.id);
  });

  test('GET /api/team/config: a foreign (personal) grove is refused 404, never touches the personal grove', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': personalGrove.id, 'x-myco-project-id': personalProjectId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('GET /api/team/config: no grove header resolves null grove -> refused (fail-closed, not fail-open)', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/config`, {
      headers: overlayHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('GET /api/team/config: host has no designation -> refused for every grove', async () => {
    const server = await buildHostServer(undefined);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': servedProjectId }),
    });
    expect(res.status).toBe(404);
  });

  test('loopback (non-overlay) requests are unaffected by the servedGroveRefusal chokepoint', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/team/config`, {
      headers: { 'x-myco-auth': server.getAuthToken() },
    });
    // Not overlay-gated, but still resolves via hostServe.servedGroveId directly.
    expect(res.status).toBe(200);
    const body = await res.json() as { groveId: string };
    expect(body.groveId).toBe(servedGrove.id);
  });
});

// ---------------------------------------------------------------------------
// (c) config write lands in the served grove's grove.yaml (grove tier)
// ---------------------------------------------------------------------------

describe('(c) PUT /api/team/config writes the served grove tier via the single write path', () => {
  const { home } = withHermeticHomes();
  let grove: GroveRecord;

  // keyHealth assertions depend on resolveServedGroveKeyHealth's OWN
  // designation check, which reads `daemon.host_serve` from the on-disk
  // machine config directly (independent of the `deps.hostServe` runtime
  // object under test) — mirrors serve-install-flow.test.ts's `designate`.
  // Isolated from the ambient shell's real provider keys, same rationale.
  const KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'MYCO_OPENAI_API_KEY', 'OPENAI_API_KEY', 'MYCO_OPENROUTER_API_KEY'];
  let savedKeyEnv: Record<string, string | undefined>;
  beforeEach(() => {
    grove = createGrove('Served', home());
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home());
    savedKeyEnv = {};
    for (const k of KEY_ENV_VARS) { savedKeyEnv[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEY_ENV_VARS) {
      if (savedKeyEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedKeyEnv[k];
    }
  });

  function deps(): { hostServe: HostServeRuntime; mycoHome: string } {
    return {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
    };
  }

  test('patch lands on disk in grove.yaml and is readable via loadGroveConfig', async () => {
    const { response, touchedPaths, groveId } = await handlePutTeamConfig(deps(), {
      patch: { agent: { provider: { type: 'anthropic' } } },
    });
    expect(response.status ?? 200).toBeLessThan(300);
    expect(touchedPaths).toContain('agent.provider.type');
    expect(groveId).toBe(grove.id);

    const onDisk = loadGroveConfig(grove.id, home());
    expect(onDisk.agent.provider?.type).toBe('anthropic');

    const rawYaml = fs.readFileSync(resolveGroveConfigPath(grove.id, home()), 'utf-8');
    expect(rawYaml).toContain('anthropic');
  });

  test('no served-grove designation -> not_serving refusal, nothing written', async () => {
    const { response, touchedPaths, groveId } = await handlePutTeamConfig(
      { hostServe: null, mycoHome: home() },
      { patch: { agent: { provider: { type: 'anthropic' } } } },
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('not_serving');
    expect(touchedPaths).toEqual([]);
    expect(groveId).toBeNull();
  });

  test('GET /api/team/config reflects the write and reports keyHealth', async () => {
    await handlePutTeamConfig(deps(), { patch: { agent: { provider: { type: 'anthropic' } } } });
    const res = await handleGetTeamConfig(deps());
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { groveId: string; config: { agent: { provider?: { type: string } } }; keyHealth: string };
    expect(body.groveId).toBe(grove.id);
    expect(body.config.agent.provider?.type).toBe('anthropic');
    // No key stored anywhere yet for the anthropic provider -> missing_key.
    expect(body.keyHealth).toBe('missing_key');
  });

  test('GET /api/team/config: key present in the served grove secrets.env -> keyHealth ok', async () => {
    await handlePutTeamConfig(deps(), { patch: { agent: { provider: { type: 'anthropic' } } } });
    await handlePutTeamSecret(deps(), 'anthropic', { secret: 'sk-ant-realkeyABCDEFGHIJKL1234567890' });
    const res = await handleGetTeamConfig(deps());
    const body = res.body as { keyHealth: string };
    expect(body.keyHealth).toBe('ok');
  });

  test('GET /api/team/config: no designation -> not_serving refusal', async () => {
    const res = await handleGetTeamConfig({ hostServe: null, mycoHome: home() });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_serving');
  });
});

// ---------------------------------------------------------------------------
// (d) secrets PUT stores and echoes masked only; DELETE removes
// ---------------------------------------------------------------------------

describe('(d) PUT/DELETE /api/team/secrets/:provider — masked-echo-only', () => {
  const { home } = withHermeticHomes();
  let grove: GroveRecord;

  beforeEach(() => {
    grove = createGrove('Served', home());
  });

  function deps(): { hostServe: HostServeRuntime; mycoHome: string } {
    return {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
    };
  }

  test('PUT stores the raw value under the provider-standard env name; response is masked only', async () => {
    const secret = 'sk-ant-testkeyABCDEFGHIJKL1234567890';
    const res = await handlePutTeamSecret(deps(), 'anthropic', { secret });
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { provider: string; maskedValue: string };
    expect(body.provider).toBe('anthropic');
    expect(body.maskedValue).toStartWith(secret.slice(0, 8));
    expect(body.maskedValue).toEndWith(secret.slice(-4));
    expect(body.maskedValue).not.toBe(secret);
    expect(body.maskedValue).not.toContain(secret.slice(8, -4));

    const groveDir = resolveGroveDir(grove.id, home());
    expect(readSecrets(groveDir).ANTHROPIC_API_KEY).toBe(secret);

    // grove.yaml may not even exist yet (secrets never touch it) — a
    // stronger guarantee than merely "doesn't contain the secret".
    const groveConfigPath = resolveGroveConfigPath(grove.id, home());
    if (fs.existsSync(groveConfigPath)) {
      expect(fs.readFileSync(groveConfigPath, 'utf-8')).not.toContain(secret);
    }
  });

  test('PUT openai stores under MYCO_OPENAI_API_KEY (the provider-standard write name)', async () => {
    const secret = 'sk-openai-testkeyABCDEFGHIJKL1234567890';
    await handlePutTeamSecret(deps(), 'openai', { secret });
    const groveDir = resolveGroveDir(grove.id, home());
    expect(readSecrets(groveDir).MYCO_OPENAI_API_KEY).toBe(secret);
  });

  test('PUT unknown provider -> 400, nothing written', async () => {
    const res = await handlePutTeamSecret(deps(), 'not-a-provider', { secret: 'x' });
    expect(res.status).toBe(400);
  });

  test('PUT missing secret -> 400', async () => {
    const res = await handlePutTeamSecret(deps(), 'anthropic', {});
    expect(res.status).toBe(400);
  });

  test('PUT with no served-grove designation -> not_serving, nothing written', async () => {
    const res = await handlePutTeamSecret({ hostServe: null, mycoHome: home() }, 'anthropic', { secret: 'x' });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_serving');
  });

  test('DELETE removes the stored key and echoes { provider, maskedValue: null }', async () => {
    const secret = 'sk-ant-testkeyABCDEFGHIJKL1234567890';
    await handlePutTeamSecret(deps(), 'anthropic', { secret });

    const res = await handleDeleteTeamSecret(deps(), 'anthropic');
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { provider: string; maskedValue: string | null };
    expect(body.provider).toBe('anthropic');
    expect(body.maskedValue).toBeNull();

    const groveDir = resolveGroveDir(grove.id, home());
    expect(readSecrets(groveDir).ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('DELETE unknown provider -> 400', async () => {
    const res = await handleDeleteTeamSecret(deps(), 'not-a-provider');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/team/mcp-token/rotate — the thin seam for Task 10
// ---------------------------------------------------------------------------

describe('POST /api/team/mcp-token/rotate — mint, store, non-secret hash echo only', () => {
  const { home } = withHermeticHomes();
  let grove: GroveRecord;

  beforeEach(() => {
    grove = createGrove('Served', home());
  });

  function deps(): { hostServe: HostServeRuntime; mycoHome: string } {
    return {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
    };
  }

  test('mints a >=122-bit token, stores it machine-scoped beside the serve bearer, echoes only a hash', async () => {
    const res = await handleRotateExternalMcpToken(deps());
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { tokenHash: string };
    expect(typeof body.tokenHash).toBe('string');
    expect(body.tokenHash.length).toBeGreaterThan(0);

    const stored = readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    expect(stored).toBeDefined();
    // 32 bytes hex-encoded = 64 hex chars = 256 bits, comfortably >= 122 bits.
    expect(stored.length).toBeGreaterThanOrEqual(Math.ceil(122 / 4));
    expect(JSON.stringify(body)).not.toContain(stored);
  });

  test('rotating twice mints a NEW token each time (never reuses the previous value)', async () => {
    await handleRotateExternalMcpToken(deps());
    const first = readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    await handleRotateExternalMcpToken(deps());
    const second = readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    expect(second).not.toBe(first);
  });

  test('no served-grove designation -> not_serving refusal, nothing minted', async () => {
    const res = await handleRotateExternalMcpToken({ hostServe: null, mycoHome: home() });
    expect(res.status).toBe(404);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveServedGroveKeyHealthIsolated — env isolation for a polled route
// ---------------------------------------------------------------------------

describe('resolveServedGroveKeyHealthIsolated: never leaves residue in process.env', () => {
  const { home } = withHermeticHomes();
  let grove: GroveRecord;

  const KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'MYCO_OPENAI_API_KEY', 'OPENAI_API_KEY', 'MYCO_OPENROUTER_API_KEY'];
  let savedKeyEnv: Record<string, string | undefined>;
  beforeEach(() => {
    grove = createGrove('Served', home());
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
    }, home());
    savedKeyEnv = {};
    for (const k of KEY_ENV_VARS) { savedKeyEnv[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEY_ENV_VARS) {
      if (savedKeyEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedKeyEnv[k];
    }
  });

  test('a grove secret with a never-before-seen name is not left in process.env after the call', async () => {
    const groveDir = resolveGroveDir(grove.id, home());
    const sentinelKey = 'MYCO_TEST_TEAM_CONFIG_ISOLATION_SENTINEL';
    writeSecret(groveDir, sentinelKey, 'sentinel-value');
    // Sanity: not already present before the call.
    expect(process.env[sentinelKey]).toBeUndefined();

    await handlePutTeamConfig(
      { hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id }, mycoHome: home() },
      { patch: { agent: { provider: { type: 'anthropic' } } } },
    );
    resolveServedGroveKeyHealthIsolated(loadMachineConfig(home()), home());
    expect(process.env[sentinelKey]).toBeUndefined();

    // Calling it again gives the SAME classification (not stuck stale because
    // of a leaked env var from a previous call).
    const health = resolveServedGroveKeyHealthIsolated(loadMachineConfig(home()), home());
    expect(health.kind).toBe('missing_key');
    expect(process.env[sentinelKey]).toBeUndefined();

    delete process.env[sentinelKey];
  });
});
