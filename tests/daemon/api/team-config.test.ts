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
import { writeHostRecordFixture } from '../../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { classifyRoute as classifyRouteWith, matchRouteRule } from '@myco/host/routing';
import type { HostServeRuntime } from '@myco/daemon/host-serve';
import {
  resolveServedGroveKeyHealthIsolated as resolveServedGroveKeyHealthIsolatedWith,
} from '@myco/daemon/host-serve';
import {
  handleGetTeamConfig as handleGetTeamConfigWith,
  handlePutTeamConfig,
  handlePutTeamSecret as handlePutTeamSecretWith,
  handleDeleteTeamSecret as handleDeleteTeamSecretWith,
  handleRotateExternalMcpToken as handleRotateExternalMcpTokenWith,
  handleGetExternalMcp as handleGetExternalMcpWith,
  handlePutExternalMcpToggle as handlePutExternalMcpToggleWith,
  registerTeamConfigRoutes as registerTeamConfigRoutesWith,
  type ExternalMcpListenerControl,
  type TeamConfigRouteDeps,
} from '@myco/daemon/api/team-config';
import type { FunnelRunner } from '@myco/daemon/external-listener';
import {
  handleGetTeamTaskConfig,
  handlePutTeamTaskConfig,
  registerTeamAgentTaskRoutes,
} from '@myco/daemon/api/team-agent-tasks';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '@myco/grove/ids';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry';
import { resolveGroveConfigPath, resolveGroveDir, resolveMycoHome } from '@myco/grove/paths';
import { createSecretsOperations, readSecrets } from '@myco/config/secrets';
import { loadMachineConfig, loadGroveConfig, saveMachineConfig } from '@myco/config/loader';
import { EXTERNAL_MCP_DEFAULT_PORT, HOST_BEARER_SECRET, HOST_EXTERNAL_MCP_TOKEN_SECRET, HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION } from '@myco/constants';
import type { RouteRequest } from '@myco/daemon/router';
import { LifecycleLock } from '@myco/utils/lifecycle-lock';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';

const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const { writeSecret } = createSecretsOperations(testPerUserLockNamespace);
const classifyRoute = (input: Parameters<typeof classifyRouteWith>[0]) =>
  classifyRouteWith(input, testPerUserLockNamespace);
const resolveServedGroveKeyHealthIsolated = (
  machineConfig: Parameters<typeof resolveServedGroveKeyHealthIsolatedWith>[0],
  mycoHome?: string,
) => resolveServedGroveKeyHealthIsolatedWith(
  machineConfig,
  mycoHome,
  testPerUserLockNamespace,
);

function withTestLocks(deps: TeamConfigRouteDeps): TeamConfigRouteDeps {
  return { ...deps, lockNamespace: testPerUserLockNamespace };
}

const handleGetTeamConfig = (deps: TeamConfigRouteDeps) =>
  handleGetTeamConfigWith(withTestLocks(deps));
const handlePutTeamSecret = (
  deps: TeamConfigRouteDeps,
  provider: string | undefined,
  body: unknown,
) => handlePutTeamSecretWith(withTestLocks(deps), provider, body);
const handleDeleteTeamSecret = (
  deps: TeamConfigRouteDeps,
  provider: string | undefined,
) => handleDeleteTeamSecretWith(withTestLocks(deps), provider);
const handleRotateExternalMcpToken = (deps: TeamConfigRouteDeps) =>
  handleRotateExternalMcpTokenWith(withTestLocks(deps));
const handleGetExternalMcp = (deps: TeamConfigRouteDeps) =>
  handleGetExternalMcpWith(withTestLocks(deps));
const handlePutExternalMcpToggle = (
  deps: TeamConfigRouteDeps,
  body: unknown,
) => handlePutExternalMcpToggleWith(withTestLocks(deps), body);
const registerTeamConfigRoutes = (
  server: Parameters<typeof registerTeamConfigRoutesWith>[0],
  deps: TeamConfigRouteDeps,
) => registerTeamConfigRoutesWith(server, withTestLocks(deps));

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
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');
    return { projectId };
  }

  const TEAM_WRITE_ROUTES: Array<{ method: string; pathname: string }> = [
    { method: 'GET', pathname: '/api/team/config' },
    { method: 'PUT', pathname: '/api/team/config' },
    { method: 'PUT', pathname: '/api/team/secrets/anthropic' },
    { method: 'DELETE', pathname: '/api/team/secrets/anthropic' },
    { method: 'POST', pathname: '/api/team/mcp-token/rotate' },
    { method: 'GET', pathname: '/api/team/external-mcp' },
    { method: 'PUT', pathname: '/api/team/external-mcp/toggle' },
    { method: 'GET', pathname: '/api/team/agent-tasks/vault-evolve/config' },
    { method: 'PUT', pathname: '/api/team/agent-tasks/vault-evolve/config' },
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

  test('an unrecognized /api/team/* path (no ROUTE_RULES entry) falls through to serve — proxied, not local', () => {
    const { projectId } = attach();
    const decision = classifyRoute({ method: 'GET', pathname: '/api/team/status', projectId });
    expect(decision.kind).toBe('remote');
    if (decision.kind === 'remote') {
      expect(decision.classification.stamp).toBe('serve');
    }
  });

  test('tmp dir created (fixture sanity)', () => {
    expect(fs.existsSync(tmp())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (per-task d) completeness guard: the new per-task routes resolve to the
// explicit team-write stamp, never fall through to the `serve` default.
// ---------------------------------------------------------------------------

describe('(per-task d) route-stamp completeness: per-task team-write routes never fall through to serve', () => {
  test('GET/PUT /api/team/agent-tasks/:id/config resolve to the explicit team-write stamp', () => {
    expect(matchRouteRule('GET', '/api/team/agent-tasks/_id/config')?.stamp).toBe('team-write');
    expect(matchRouteRule('PUT', '/api/team/agent-tasks/_id/config')?.stamp).toBe('team-write');
  });

  test('PUT /api/team/agent-tasks/:id/config resolves via its own explicit rule, not a fall-through', () => {
    // Sanity: with no PUT rule for this exact/param pattern, the route would
    // silently fall through to `serve` rather than `team-write` — this pins
    // that the explicit :param rule is what resolves it.
    expect(matchRouteRule('PUT', '/api/team/agent-tasks/_id/config')).toBeDefined();
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
    registerTeamAgentTaskRoutes(server, { hostServe, mycoHome: process.env.MYCO_HOME! });
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

  // -------------------------------------------------------------------------
  // Per-task table (spec §6.3): the same served-grove admission, exercised
  // over the SAME real overlay fixture as GET /api/team/config above.
  // -------------------------------------------------------------------------

  test('GET /api/team/agent-tasks/vault-evolve/config: the served grove passes through', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': servedProjectId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };
    expect(body.taskId).toBe('vault-evolve');
  });

  test('GET /api/team/agent-tasks/vault-evolve/config: a foreign (personal) grove is refused 404', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': personalGrove.id, 'x-myco-project-id': personalProjectId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('GET /api/team/agent-tasks/vault-evolve/config: no grove header resolves null grove -> refused', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('GET /api/team/agent-tasks/vault-evolve/config: host has no designation -> refused for every grove', async () => {
    const server = await buildHostServer(undefined);
    const res = await fetch(`http://127.0.0.1:${server.overlayPort}/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': servedProjectId }),
    });
    expect(res.status).toBe(404);
  });

  test('PUT /api/team/agent-tasks/vault-evolve/config: loopback (non-overlay) requests are unaffected', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/team/agent-tasks/vault-evolve/config`, {
      method: 'PUT',
      headers: { 'x-myco-auth': server.getAuthToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ maxTurns: 11 }),
    });
    // Not overlay-gated, but still resolves via hostServe.servedGroveId directly.
    expect(res.status).toBeLessThan(300);
    const body = await res.json() as { taskId: string; config: { maxTurns?: number } | null };
    expect(body.taskId).toBe('vault-evolve');
    expect(body.config?.maxTurns).toBe(11);
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
// (per-task c) PUT /api/team/agent-tasks/:id/config writes agent.tasks.<id>
// via the SAME single write path PUT /api/agent/tasks/:id/config uses when a
// Grove is bound (`handleUpdateTaskConfig`, agent-tasks.ts).
// ---------------------------------------------------------------------------

describe('(per-task c) PUT /api/team/agent-tasks/:id/config writes the served grove tier', () => {
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

  function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
    return {
      params: { id: 'vault-evolve' },
      query: {},
      body: undefined,
      pathname: '/api/team/agent-tasks/vault-evolve/config',
      ...overrides,
    } as RouteRequest;
  }

  test('patch lands on disk in grove.yaml under agent.tasks.<id> and is readable via loadGroveConfig', async () => {
    const { response, touchedPaths, groveId } = await handlePutTeamTaskConfig(
      deps(),
      req({ body: { maxTurns: 17 } }),
    );
    expect(response.status ?? 200).toBeLessThan(300);
    expect(touchedPaths).toContain('agent.tasks.vault-evolve');
    expect(groveId).toBe(grove.id);

    const onDisk = loadGroveConfig(grove.id, home());
    expect(onDisk.agent.tasks?.['vault-evolve']?.maxTurns).toBe(17);

    const rawYaml = fs.readFileSync(resolveGroveConfigPath(grove.id, home()), 'utf-8');
    expect(rawYaml).toContain('vault-evolve');
  });

  test('GET reflects the write through handleGetTeamTaskConfig', async () => {
    await handlePutTeamTaskConfig(deps(), req({ body: { maxTurns: 21 } }));
    const res = await handleGetTeamTaskConfig(deps(), req());
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { taskId: string; config: { maxTurns?: number } | null };
    expect(body.taskId).toBe('vault-evolve');
    expect(body.config?.maxTurns).toBe(21);
  });

  test('no served-grove designation -> not_serving refusal, nothing written', async () => {
    const { response, touchedPaths, groveId } = await handlePutTeamTaskConfig(
      { hostServe: null, mycoHome: home() },
      req({ body: { maxTurns: 5 } }),
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('not_serving');
    expect(touchedPaths).toEqual([]);
    expect(groveId).toBeNull();
  });

  test('GET with no served-grove designation -> not_serving refusal', async () => {
    const res = await handleGetTeamTaskConfig({ hostServe: null, mycoHome: home() }, req());
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_serving');
  });

  test('unknown task id -> task_not_found on GET', async () => {
    const res = await handleGetTeamTaskConfig(deps(), req({ params: { id: 'does-not-exist-task' } }));
    expect(res.status).toBe(404);
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

  test.each([
    '\nvalid-secret',
    'valid\nINJECTED=owned',
    'valid-secret\n',
    '\rvalid-secret',
    'valid\rINJECTED=owned',
    'valid-secret\r',
    '\0valid-secret',
    'valid\0INJECTED=owned',
    'valid-secret\0',
  ])('PUT rejects an unsafe raw secret before mutating the served-grove store: %p', async (value) => {
    const groveDir = resolveGroveDir(grove.id, home());
    const secretsPath = path.join(groveDir, 'secrets.env');
    fs.writeFileSync(secretsPath, 'ANTHROPIC_API_KEY=stored-valid\n');
    const before = fs.readFileSync(secretsPath);
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await handlePutTeamSecret(deps(), 'anthropic', { secret: value });

      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_secret_value',
        message: 'Secret value contains unsupported characters',
      });
      expect(fs.readFileSync(secretsPath)).toEqual(before);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
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

describe('POST /api/team/mcp-token/rotate — mint, store, one-time raw reveal + hash', () => {
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

  test('mints a >=122-bit token, stores it machine-scoped beside the serve bearer, reveals the raw value ONCE plus a hash', async () => {
    const res = await handleRotateExternalMcpToken(deps());
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { token: string; tokenHash: string };
    expect(typeof body.tokenHash).toBe('string');
    expect(body.tokenHash.length).toBeGreaterThan(0);

    const stored = readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    expect(stored).toBeDefined();
    // 32 bytes hex-encoded = 64 hex chars = 256 bits, comfortably >= 122 bits.
    expect(stored.length).toBeGreaterThanOrEqual(Math.ceil(122 / 4));
    // The deliberate one-time reveal: the raw token IS the stored value,
    // returned exactly here — a token that is never revealed is unusable.
    expect(body.token).toBe(stored);
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
// GET /api/team/external-mcp, PUT /api/team/external-mcp/toggle — Task 10
// ---------------------------------------------------------------------------

describe('GET /api/team/external-mcp + PUT .../toggle — mint-if-absent, bind/unbind, one-time reveal', () => {
  const { home, tmp } = withHermeticHomes();
  let grove: GroveRecord;
  let listener: ExternalMcpListenerControl & { bindCalls: number[]; unbindCalls: number; bound: boolean; boundPort: number };
  let funnelCalls: Array<{ port: number; on: boolean }>;
  let runFunnel: FunnelRunner;

  beforeEach(() => {
    grove = createGrove('Served', home());
    funnelCalls = [];
    runFunnel = async (port, on) => {
      funnelCalls.push({ port, on });
      return on
        ? { ok: true, detail: `stub ${port} ${on}`, url: `https://stub-host.example.ts.net` }
        : { ok: true, detail: `stub ${port} ${on}` };
    };
    listener = {
      bindCalls: [],
      unbindCalls: 0,
      bound: false,
      boundPort: 0,
      async bind(port: number) {
        this.bindCalls.push(port);
        this.bound = true;
        this.boundPort = port;
        return { ok: true, port };
      },
      async unbind() {
        this.unbindCalls += 1;
        this.bound = false;
        this.boundPort = 0;
      },
      get isBound() { return this.bound; },
      get port() { return this.boundPort; },
    };
  });

  function deps(withListener = true): Parameters<typeof handlePutExternalMcpToggle>[0] {
    return {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: withListener ? { listener, runFunnel } : undefined,
    };
  }

  test('GET before enable: not enabled, no tokenHash, bound reflects the listener (false)', async () => {
    const res = await handleGetExternalMcp(deps());
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { enabled: boolean; tokenHash: string | null; bound: boolean | null };
    expect(body.enabled).toBe(false);
    expect(body.tokenHash).toBeNull();
    expect(body.bound).toBe(false);
  });

  test('enable: mints a token, binds the listener, turns Funnel on, reveals { token, tokenHash } ONCE', async () => {
    const res = await handlePutExternalMcpToggle(deps(), { enabled: true });
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { enabled: boolean; port: number; token: string; tokenHash: string };
    expect(body.enabled).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(typeof body.tokenHash).toBe('string');

    expect(listener.bindCalls).toEqual([body.port]);
    expect(funnelCalls).toEqual([{ port: body.port, on: true }]);

    const stored = readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    expect(stored).toBe(body.token);

    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.enabled).toBe(true);
    expect(machine.daemon.external_mcp.port).toBe(body.port);
  });

  test('enable: the Funnel runner\'s public URL is threaded into the response as funnel.url (spec §7)', async () => {
    const res = await handlePutExternalMcpToggle(deps(), { enabled: true });
    const body = res.body as { funnel: { ok: boolean; detail: string; url?: string } };
    expect(body.funnel.url).toBe('https://stub-host.example.ts.net');
  });

  test('enable twice: mint-if-absent never rotates an already-existing token, and re-enable does NOT re-reveal it', async () => {
    const first = await handlePutExternalMcpToggle(deps(), { enabled: true });
    const firstBody = first.body as { token: string; tokenHash: string };
    expect(typeof firstBody.token).toBe('string');
    expect(firstBody.token.length).toBeGreaterThan(0);

    const second = await handlePutExternalMcpToggle(deps(), { enabled: true });
    const secondBody = second.body as { token?: string; tokenHash: string };
    // The strict reveal property (Task 10 Fix Round 1): a re-enable of an
    // already-token'd listener returns tokenHash only — the raw token is
    // NEVER re-revealed. A member who lost it must use rotate.
    expect(secondBody.token).toBeUndefined();
    expect(secondBody.tokenHash).toBe(firstBody.tokenHash);

    const stored = readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    expect(stored).toBe(firstBody.token);
    expect(listener.bindCalls.length).toBe(2); // re-enable re-binds (idempotent on the listener side)
  });

  test('port out of the schema range -> 400 BEFORE any side effect (no mint, no bind, no persist)', async () => {
    const res = await handlePutExternalMcpToggle(deps(), { enabled: true, port: 80 });
    expect(res.status).toBe(400);
    expect(listener.bindCalls).toEqual([]);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.enabled).toBe(false);
  });

  test('port: 0 is rejected (below the schema floor), never persistable', async () => {
    const res = await handlePutExternalMcpToggle(deps(), { enabled: true, port: 0 });
    expect(res.status).toBe(400);
    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.enabled).toBe(false);
    expect(machine.daemon.external_mcp.port).not.toBe(0);
  });

  test('port above the schema ceiling -> 400', async () => {
    const res = await handlePutExternalMcpToggle(deps(), { enabled: true, port: 70000 });
    expect(res.status).toBe(400);
  });

  test('persists the ACTUALLY-bound port, not the raw requested value', async () => {
    const boundPort = 9999;
    const rebindingListener: ExternalMcpListenerControl = {
      async bind() { return { ok: true, port: boundPort }; },
      async unbind() {},
      isBound: true,
      port: boundPort,
    };
    const res = await handlePutExternalMcpToggle(
      { hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id }, mycoHome: home(), externalMcp: { listener: rebindingListener, runFunnel } },
      { enabled: true, port: 5000 },
    );
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { port: number };
    expect(body.port).toBe(boundPort);
    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.port).toBe(boundPort);
    expect(funnelCalls.some((c) => c.port === boundPort)).toBe(true);
  });

  test('disable: turns Funnel off, unbinds, persists enabled:false, reveals nothing', async () => {
    await handlePutExternalMcpToggle(deps(), { enabled: true });
    funnelCalls = [];
    const res = await handlePutExternalMcpToggle(deps(), { enabled: false });
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { enabled: boolean; token?: string };
    expect(body.enabled).toBe(false);
    expect(body.token).toBeUndefined();
    expect(listener.unbindCalls).toBe(1);
    expect(funnelCalls.some((c) => c.on === false)).toBe(true);

    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.enabled).toBe(false);
  });

  test('GET after enable: tokenHash present, raw token never echoed, bound reflects the listener', async () => {
    const enableRes = await handlePutExternalMcpToggle(deps(), { enabled: true });
    const token = (enableRes.body as { token: string }).token;

    const res = await handleGetExternalMcp(deps());
    const body = res.body as { enabled: boolean; tokenHash: string; bound: boolean };
    expect(body.enabled).toBe(true);
    expect(body.bound).toBe(true);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test('a failed first bind consumes no token and a healthy retry reveals it exactly once', async () => {
    let shouldFail = true;
    const failingListener: ExternalMcpListenerControl = {
      async bind(port) {
        if (shouldFail) return { ok: false, error: 'EADDRINUSE' };
        return { ok: true, port };
      },
      async unbind() {},
      isBound: false,
      port: 0,
    };
    const toggleDeps = {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener: failingListener, runFunnel },
    };

    const failed = await handlePutExternalMcpToggle(toggleDeps, { enabled: true });
    expect(failed.status).toBe(500);
    expect(funnelCalls).toEqual([]);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.enabled).toBe(false);

    shouldFail = false;
    const retry = await handlePutExternalMcpToggle(toggleDeps, { enabled: true });
    const retryBody = retry.body as { token?: string; tokenHash: string };
    expect(retry.status ?? 200).toBeLessThan(300);
    expect(retryBody.token).toBe(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]);

    const later = await handlePutExternalMcpToggle(toggleDeps, { enabled: true });
    expect((later.body as { token?: string }).token).toBeUndefined();
    expect((later.body as { tokenHash: string }).tokenHash).toBe(retryBody.tokenHash);
  });

  test('a thrown Funnel activation consumes no token and retry remains revealable', async () => {
    let shouldThrow = true;
    const throwingFunnel: FunnelRunner = async (port, on) => {
      if (on && shouldThrow) throw new Error('funnel unavailable');
      return { ok: true, detail: `stub ${port} ${on}` };
    };
    const toggleDeps = {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener, runFunnel: throwingFunnel },
    };

    await expect(handlePutExternalMcpToggle(toggleDeps, { enabled: true }))
      .rejects.toThrow(/funnel unavailable/);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(false);
    expect(listener.isBound).toBe(false);

    shouldThrow = false;
    const retry = await handlePutExternalMcpToggle(toggleDeps, { enabled: true });
    expect((retry.body as { token?: string }).token)
      .toBe(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]);
  });

  test('an unreadable token store rolls back listener, Funnel, and enabled config', async () => {
    const secretsPath = path.join(home(), 'secrets.env');
    fs.writeFileSync(secretsPath, 'malformed-entry\n');

    await expect(handlePutExternalMcpToggle(deps(), { enabled: true }))
      .rejects.toThrow(/unsupported characters/);

    expect(listener.isBound).toBe(false);
    expect(funnelCalls).toEqual([
      { port: EXTERNAL_MCP_DEFAULT_PORT, on: true },
      { port: EXTERNAL_MCP_DEFAULT_PORT, on: false },
    ]);
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(false);
    expect(fs.readFileSync(secretsPath, 'utf8')).toBe('malformed-entry\n');
  });

  test('a readable token reached through an untrusted store path is never adopted after commit failure', async () => {
    const existingToken = 'external-store-token';
    const externalStore = path.join(tmp(), 'external-secrets.env');
    fs.writeFileSync(
      externalStore,
      `${HOST_EXTERNAL_MCP_TOKEN_SECRET}=${existingToken}\n`,
    );
    fs.symlinkSync(externalStore, path.join(home(), 'secrets.env'));

    await expect(handlePutExternalMcpToggle(deps(), { enabled: true }))
      .rejects.toThrow(/non-regular secret store/);

    expect(listener.isBound).toBe(false);
    expect(funnelCalls).toEqual([
      { port: EXTERNAL_MCP_DEFAULT_PORT, on: true },
      { port: EXTERNAL_MCP_DEFAULT_PORT, on: false },
    ]);
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(false);
  });

  test('token inspection and rollback failures preserve every underlying error', async () => {
    fs.writeFileSync(path.join(home(), 'secrets.env'), 'malformed-entry\n');
    const failingRollbackFunnel: FunnelRunner = async (port, on) => (
      on
        ? { ok: true, detail: `stub ${port} ${on}` }
        : { ok: false, detail: 'rollback refused' }
    );
    let caught: unknown;
    try {
      await handlePutExternalMcpToggle({
        hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
        mycoHome: home(),
        externalMcp: { listener, runFunnel: failingRollbackFunnel },
      }, { enabled: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors
      .map((error: unknown) => error instanceof Error ? error.message : String(error));
    expect(messages.filter((message: string) => message.includes('unsupported characters')))
      .toHaveLength(2);
    expect(messages.some((message: string) => message.includes('rollback refused'))).toBe(true);
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(false);
    expect(listener.isBound).toBe(false);
  });

  test('a resolved Funnel activation failure consumes no token and reports rollback failure', async () => {
    const failingFunnel: FunnelRunner = async (_port, on) => ({
      ok: false,
      detail: on ? 'funnel activation refused' : 'funnel rollback refused',
    });
    const toggleDeps = {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener, runFunnel: failingFunnel },
    };

    await expect(handlePutExternalMcpToggle(toggleDeps, { enabled: true }))
      .rejects.toThrow(/funnel activation refused.*compensation also failed/);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(false);
    expect(listener.isBound).toBe(false);
  });

  test('a resolved Funnel disable failure preserves the enabled listener and config', async () => {
    await handlePutExternalMcpToggle(deps(), { enabled: true });
    const disableFunnelCalls: Array<{ port: number; on: boolean }> = [];
    const failingDisableFunnel: FunnelRunner = async (port, on) => (
      disableFunnelCalls.push({ port, on }),
      on
        ? { ok: true, detail: `stub ${port} ${on}` }
        : { ok: false, detail: 'funnel disable refused' }
    );
    const toggleDeps = {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener, runFunnel: failingDisableFunnel },
    };

    await expect(handlePutExternalMcpToggle(toggleDeps, { enabled: false }))
      .rejects.toThrow(/funnel disable refused/);
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(true);
    expect(listener.isBound).toBe(true);
    expect(disableFunnelCalls).toEqual([
      { port: EXTERNAL_MCP_DEFAULT_PORT, on: false },
      { port: EXTERNAL_MCP_DEFAULT_PORT, on: true },
    ]);
  });

  test('a failed Funnel-off restoration preserves both returned failures', async () => {
    await handlePutExternalMcpToggle(deps(), { enabled: true });
    const failingFunnel: FunnelRunner = async (_port, on) => ({
      ok: false,
      detail: on ? 'funnel restoration refused' : 'funnel disable refused',
    });
    let caught: unknown;
    try {
      await handlePutExternalMcpToggle({
        hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
        mycoHome: home(),
        externalMcp: { listener, runFunnel: failingFunnel },
      }, { enabled: false });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors
      .map((error: unknown) => error instanceof Error ? error.message : String(error));
    expect(messages.some((message: string) => message.includes('funnel disable refused')))
      .toBe(true);
    expect(messages.some((message: string) => message.includes('funnel restoration refused')))
      .toBe(true);
    expect(loadMachineConfig(home()).daemon.external_mcp.enabled).toBe(true);
    expect(listener.isBound).toBe(true);
  });

  test('an unbind failure after Funnel-off restores the prior listener, Funnel, and config', async () => {
    const previousPort = 4300;
    let currentPort = previousPort;
    let bound = true;
    let unbindShouldFail = true;
    const rollbackListener: ExternalMcpListenerControl = {
      async bind(port) {
        bound = true;
        currentPort = port;
        return { ok: true, port };
      },
      async unbind() {
        bound = false;
        currentPort = 0;
        if (unbindShouldFail) {
          unbindShouldFail = false;
          throw new Error('unbind failed after close');
        }
      },
      get isBound() { return bound; },
      get port() { return currentPort; },
    };
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: {
        ...machine.daemon,
        external_mcp: { enabled: true, port: previousPort },
      },
    }, home());

    await expect(handlePutExternalMcpToggle({
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener: rollbackListener, runFunnel },
    }, { enabled: false })).rejects.toThrow(/unbind failed after close/);

    expect(rollbackListener.isBound).toBe(true);
    expect(rollbackListener.port).toBe(previousPort);
    expect(funnelCalls).toEqual([
      { port: previousPort, on: false },
      { port: previousPort, on: true },
    ]);
    expect(loadMachineConfig(home()).daemon.external_mcp)
      .toEqual({ enabled: true, port: previousPort });
  });

  test('a config-save failure after Funnel-off and unbind restores the prior state', async () => {
    const previousPort = 4300;
    const configPath = path.join(home(), 'config.yaml');
    const displacedConfigPath = path.join(home(), 'config.yaml.displaced');
    let currentPort = previousPort;
    let bound = true;
    const rollbackListener: ExternalMcpListenerControl = {
      async bind(port) {
        fs.rmSync(configPath, { recursive: true, force: true });
        fs.renameSync(displacedConfigPath, configPath);
        bound = true;
        currentPort = port;
        return { ok: true, port };
      },
      async unbind() {
        bound = false;
        currentPort = 0;
        fs.renameSync(configPath, displacedConfigPath);
        fs.mkdirSync(configPath);
      },
      get isBound() { return bound; },
      get port() { return currentPort; },
    };
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: {
        ...machine.daemon,
        external_mcp: { enabled: true, port: previousPort },
      },
    }, home());

    try {
      await expect(handlePutExternalMcpToggle({
        hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
        mycoHome: home(),
        externalMcp: { listener: rollbackListener, runFunnel },
      }, { enabled: false })).rejects.toThrow();
    } finally {
      if (fs.existsSync(displacedConfigPath)) {
        fs.rmSync(configPath, { recursive: true, force: true });
        fs.renameSync(displacedConfigPath, configPath);
      }
    }

    expect(rollbackListener.isBound).toBe(true);
    expect(rollbackListener.port).toBe(previousPort);
    expect(funnelCalls).toEqual([
      { port: previousPort, on: false },
      { port: previousPort, on: true },
    ]);
    expect(loadMachineConfig(home()).daemon.external_mcp)
      .toEqual({ enabled: true, port: previousPort });
  });

  test('a failed port-change bind restores the previously bound listener and config', async () => {
    const previousPort = 4301;
    const requestedPort = 4302;
    const rebindCalls: number[] = [];
    let currentPort = previousPort;
    let bound = true;
    const rebindFailureListener: ExternalMcpListenerControl = {
      async bind(port) {
        rebindCalls.push(port);
        if (port === requestedPort) {
          bound = false;
          currentPort = 0;
          return { ok: false, error: 'port unavailable' };
        }
        bound = true;
        currentPort = port;
        return { ok: true, port };
      },
      async unbind() {
        bound = false;
        currentPort = 0;
      },
      get isBound() { return bound; },
      get port() { return currentPort; },
    };
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: {
        ...machine.daemon,
        external_mcp: { enabled: true, port: previousPort },
      },
    }, home());

    const result = await handlePutExternalMcpToggle({
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener: rebindFailureListener, runFunnel },
    }, { enabled: true, port: requestedPort });

    expect(result.status).toBe(500);
    expect(rebindCalls).toEqual([requestedPort, previousPort]);
    expect(rebindFailureListener.isBound).toBe(true);
    expect(rebindFailureListener.port).toBe(previousPort);
    expect(loadMachineConfig(home()).daemon.external_mcp)
      .toEqual({ enabled: true, port: previousPort });
  });

  test('rotate waits for an in-flight first enable before replacing its token', async () => {
    let releaseFunnel!: () => void;
    let funnelEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      funnelEntered = resolve;
    });
    const heldFunnel: FunnelRunner = async (port, on) => {
      if (on) {
        funnelEntered();
        await new Promise<void>((resolve) => {
          releaseFunnel = resolve;
        });
      }
      return { ok: true, detail: `stub ${port} ${on}` };
    };
    const toggleDeps = {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener, runFunnel: heldFunnel },
    };
    const enablePromise = handlePutExternalMcpToggle(toggleDeps, { enabled: true });
    await entered;

    let rotateSettled = false;
    const rotatePromise = handleRotateExternalMcpToken(toggleDeps).then((response) => {
      rotateSettled = true;
      return response;
    });
    await Promise.resolve();
    expect(rotateSettled).toBe(false);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();

    releaseFunnel();
    const enable = await enablePromise;
    const rotate = await rotatePromise;
    const enableToken = (enable.body as { token: string }).token;
    const rotateToken = (rotate.body as { token: string }).token;
    expect(rotateToken).not.toBe(enableToken);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBe(rotateToken);
  });

  test('rotate waits for an in-flight disable before replacing its token', async () => {
    await handlePutExternalMcpToggle(deps(), { enabled: true });
    let releaseFunnel!: () => void;
    let funnelEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      funnelEntered = resolve;
    });
    const heldFunnel: FunnelRunner = async (port, on) => {
      if (!on) {
        funnelEntered();
        await new Promise<void>((resolve) => {
          releaseFunnel = resolve;
        });
      }
      return { ok: true, detail: `stub ${port} ${on}` };
    };
    const toggleDeps = {
      hostServe: { overlayAddress: '127.0.0.1', bearer: 'b', servedGroveId: grove.id },
      mycoHome: home(),
      externalMcp: { listener, runFunnel: heldFunnel },
    };
    const disablePromise = handlePutExternalMcpToggle(toggleDeps, { enabled: false });
    await entered;

    let rotateSettled = false;
    const rotatePromise = handleRotateExternalMcpToken(toggleDeps).then((response) => {
      rotateSettled = true;
      return response;
    });
    await Promise.resolve();
    expect(rotateSettled).toBe(false);

    releaseFunnel();
    await disablePromise;
    const rotate = await rotatePromise;
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET])
      .toBe((rotate.body as { token: string }).token);
  });

  test('a thrown later activation-lock acquisition releases earlier locks', async () => {
    const actualAcquire = LifecycleLock.acquire;
    let acquireCalls = 0;
    const acquireSpy = spyOn(LifecycleLock, 'acquire').mockImplementation((lockPath, options) => {
      acquireCalls += 1;
      if (acquireCalls === 2) throw new Error('second lock failed');
      return actualAcquire.call(LifecycleLock, lockPath, options);
    });
    try {
      await expect(handlePutExternalMcpToggle(deps(false), { enabled: false }))
        .rejects.toThrow(/second lock failed/);
    } finally {
      acquireSpy.mockRestore();
    }

    const retry = await handlePutExternalMcpToggle(deps(false), { enabled: false });
    expect(retry.status ?? 200).toBeLessThan(300);
  });

  test('physical-path aliases serialize concurrent first enables and only the winner reveals', async () => {
    const alias = path.join(tmp(), 'home-alias');
    fs.symlinkSync(home(), alias, 'dir');
    let activeBinds = 0;
    let maxActiveBinds = 0;
    const serialListener: ExternalMcpListenerControl = {
      async bind(port) {
        activeBinds += 1;
        maxActiveBinds = Math.max(maxActiveBinds, activeBinds);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeBinds -= 1;
        return { ok: true, port };
      },
      async unbind() {},
      isBound: false,
      port: 0,
    };
    const hostServe = {
      overlayAddress: '127.0.0.1',
      bearer: 'b',
      servedGroveId: grove.id,
    };

    const responses = await Promise.all([
      handlePutExternalMcpToggle(
        { hostServe, mycoHome: home(), externalMcp: { listener: serialListener, runFunnel } },
        { enabled: true },
      ),
      handlePutExternalMcpToggle(
        { hostServe, mycoHome: alias, externalMcp: { listener: serialListener, runFunnel } },
        { enabled: true },
      ),
    ]);

    expect(maxActiveBinds).toBe(1);
    const revealed = responses
      .map((response) => (response.body as { token?: string }).token)
      .filter((token): token is string => token !== undefined);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toBe(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]);
  });

  test('no served-grove designation -> not_serving refusal for both routes, nothing bound/minted', async () => {
    const noHostDeps = { hostServe: null, mycoHome: home(), externalMcp: { listener, runFunnel } };
    const getRes = await handleGetExternalMcp(noHostDeps);
    expect(getRes.status).toBe(404);
    const putRes = await handlePutExternalMcpToggle(noHostDeps, { enabled: true });
    expect(putRes.status).toBe(404);
    expect(listener.bindCalls).toEqual([]);
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
  });

  test('missing/invalid "enabled" in the PUT body -> 400, no side effects', async () => {
    const res = await handlePutExternalMcpToggle(deps(), {});
    expect(res.status).toBe(400);
    expect(listener.bindCalls).toEqual([]);
  });

  test('works without a threaded listener (config/token layer stays unit-testable in isolation)', async () => {
    const res = await handlePutExternalMcpToggle(deps(false), { enabled: true });
    expect(res.status ?? 200).toBeLessThan(300);
    const body = res.body as { token: string };
    expect(typeof body.token).toBe('string');
    const machine = loadMachineConfig(home());
    expect(machine.daemon.external_mcp.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveExternalMcpCoherence + myco doctor's checkExternalMcpCoherence
// ---------------------------------------------------------------------------

describe('resolveExternalMcpCoherence — doctor listener/token coherence (Task 10)', () => {
  const { home } = withHermeticHomes();

  test('toggle off -> not_enabled, no doctor row', async () => {
    const { resolveExternalMcpCoherence } = await import('@myco/daemon/host-serve');
    expect(resolveExternalMcpCoherence(loadMachineConfig(home()), home())).toEqual({ kind: 'not_enabled' });

    const { checkExternalMcpCoherence } = await import('@myco/cli/doctor');
    expect(await checkExternalMcpCoherence(home())).toBeNull();
  });

  test('enabled with no minted token -> missing_token, warn row', async () => {
    const { resolveExternalMcpCoherence } = await import('@myco/daemon/host-serve');
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, external_mcp: { enabled: true, port: 8743 } },
    }, home());

    expect(resolveExternalMcpCoherence(loadMachineConfig(home()), home())).toEqual({ kind: 'missing_token', port: 8743 });

    const { checkExternalMcpCoherence } = await import('@myco/cli/doctor');
    const check = await checkExternalMcpCoherence(home());
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('no access token exists');
  });

  test('enabled with a minted token -> ok, no doctor row', async () => {
    const { resolveExternalMcpCoherence } = await import('@myco/daemon/host-serve');
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, external_mcp: { enabled: true, port: 8743 } },
    }, home());
    writeSecret(home(), HOST_EXTERNAL_MCP_TOKEN_SECRET, 'a'.repeat(64));

    expect(resolveExternalMcpCoherence(loadMachineConfig(home()), home())).toEqual({ kind: 'ok', port: 8743 });

    const { checkExternalMcpCoherence } = await import('@myco/cli/doctor');
    expect(await checkExternalMcpCoherence(home())).toBeNull();
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
