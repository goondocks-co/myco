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
import { teamFetch, teamSocketPath, removeSocket } from '../../helpers/team-socket.js';
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
  type TeamConfigRouteDeps,
} from '@myco/daemon/api/team-config';
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
import { resolveExternalMcpSocketPath } from '@myco/daemon/external-listener';
import { loadMachineConfig, loadGroveConfig, saveMachineConfig } from '@myco/config/loader';
import { HOST_BEARER_SECRET, HOST_EXTERNAL_MCP_TOKEN_SECRET, HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION } from '@myco/constants';
import type { RouteRequest } from '@myco/daemon/router';
import { ExternalMcpContainmentBusyError } from '@myco/daemon/external-mcp-containment';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';
import { seedExternalMcpConfig } from '../../helpers/external-mcp-config-fixture.js';

let teamSock: string;

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
      host_url: 'https://host-a.tailnet.ts.net:8443',
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
      bearer: HOST_BEARER,
      servedGroveId,
    };
    const hostVaultDir = path.join(tmp, 'host-anchor', '.myco');
    const logger = new DaemonLogger(path.join(tmp, 'host-logs'));
    teamSock = teamSocketPath();
    const server = new DaemonServer({
      teamSocketPath: teamSock,
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
    const res = await teamFetch(teamSock, `/api/team/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': servedProjectId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { groveId: string };
    expect(body.groveId).toBe(servedGrove.id);
  });

  test('GET /api/team/config: a foreign (personal) grove is refused 404, never touches the personal grove', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await teamFetch(teamSock, `/api/team/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': personalGrove.id, 'x-myco-project-id': personalProjectId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('GET /api/team/config: no grove header resolves null grove -> refused (fail-closed, not fail-open)', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await teamFetch(teamSock, `/api/team/config`, {
      headers: overlayHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('GET /api/team/config: host has no designation -> refused for every grove', async () => {
    const server = await buildHostServer(undefined);
    const res = await teamFetch(teamSock, `/api/team/config`, {
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
    const res = await teamFetch(teamSock, `/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': servedProjectId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };
    expect(body.taskId).toBe('vault-evolve');
  });

  test('GET /api/team/agent-tasks/vault-evolve/config: a foreign (personal) grove is refused 404', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await teamFetch(teamSock, `/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders({ 'x-myco-grove-id': personalGrove.id, 'x-myco-project-id': personalProjectId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('GET /api/team/agent-tasks/vault-evolve/config: no grove header resolves null grove -> refused', async () => {
    const server = await buildHostServer(servedGrove.id);
    const res = await teamFetch(teamSock, `/api/team/agent-tasks/vault-evolve/config`, {
      headers: overlayHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('GET /api/team/agent-tasks/vault-evolve/config: host has no designation -> refused for every grove', async () => {
    const server = await buildHostServer(undefined);
    const res = await teamFetch(teamSock, `/api/team/agent-tasks/vault-evolve/config`, {
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
      hostServe: { bearer: 'b', servedGroveId: grove.id },
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
      hostServe: { bearer: 'b', servedGroveId: grove.id },
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
      hostServe: { bearer: 'b', servedGroveId: grove.id },
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

describe('external MCP routes — fail-closed activation and containment-only disable', () => {
  const { home } = withHermeticHomes();
  let grove: GroveRecord;
  let containCalls: string[];
  let enableCalls: Array<{ socketPath: string; mintToken: () => { value: string; minted: boolean } }>;
  let enableResult:
    | { ok: true; funnelUrl: string | null; minted: boolean; token?: string }
    | { ok: false; error: string };
  let containmentResult: {
    enabled: boolean;
    port: number;
    funnel: Array<{ ok: boolean; detail: string }>;
  };

  beforeEach(() => {
    grove = createGrove('Served', home());
    containCalls = [];
    enableCalls = [];
    enableResult = { ok: true, funnelUrl: 'https://host.ts.net/mcp', minted: false };
    containmentResult = {
      enabled: false,
      port: 8743,
      funnel: [{ ok: true, detail: 'off 8743' }],
    };
  });

  function deps(): TeamConfigRouteDeps {
    return {
      hostServe: {
        bearer: 'b',
        servedGroveId: grove.id,
      },
      mycoHome: home(),
      externalMcp: {
        listener: {
          isBound: false,
          boundTarget: null,
          async unbind() {},
          async bind() {
            return { ok: false, error: 'fake listener never binds' };
          },
        },
        containment: {
          async contain(operation) {
            containCalls.push(operation);
            return containmentResult;
          },
          async enable(enableDeps) {
            containCalls.push('enable');
            enableCalls.push(enableDeps);
            return enableResult;
          },
        },
      },
    };
  }

  test('enable routes through the containment authority with the derived socket and reveals the token ONLY on mint', async () => {
    enableResult = { ok: true, funnelUrl: 'https://host.ts.net/mcp', minted: true, token: 'raw-minted-token' };
    writeSecret(home(), HOST_EXTERNAL_MCP_TOKEN_SECRET, 'raw-minted-token');

    const response = await handlePutExternalMcpToggle(deps(), { enabled: true });

    expect(containCalls).toEqual(['enable']);
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0]!.socketPath).toBe(resolveExternalMcpSocketPath(home()));
    expect(response.body).toMatchObject({
      enabled: true,
      funnel_url: 'https://host.ts.net/mcp',
      token: 'raw-minted-token',
    });
  });

  test('a replayed enable (token already minted) NEVER echoes the stored token', async () => {
    enableResult = { ok: true, funnelUrl: 'https://host.ts.net/mcp', minted: false };
    writeSecret(home(), HOST_EXTERNAL_MCP_TOKEN_SECRET, 'stored-secret-token');

    const response = await handlePutExternalMcpToggle(deps(), { enabled: true });

    expect(JSON.stringify(response.body)).not.toContain('stored-secret-token');
    expect((response.body as { tokenHash: string | null }).tokenHash).toBeTruthy();
  });

  test('an enable failure surfaces as 502 with the containment detail, nothing minted here', async () => {
    enableResult = { ok: false, error: 'could not activate the public Funnel: no vendor tailscaled' };

    const response = await handlePutExternalMcpToggle(deps(), { enabled: true });

    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toContain('could not activate the public Funnel');
  });

  test('the mintToken closure handed to enable mints-if-absent into the machine secret store', async () => {
    let minted: { value: string; minted: boolean } | undefined;
    enableResult = { ok: true, funnelUrl: null, minted: true };
    const captured = deps();
    await handlePutExternalMcpToggle(captured, { enabled: true });
    minted = enableCalls[0]!.mintToken();
    expect(minted.minted).toBe(true);
    expect(minted.value).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent: the second call returns the SAME stored value, not a fresh one.
    const again = enableCalls[0]!.mintToken();
    expect(again.minted).toBe(false);
    expect(again.value).toBe(minted.value);
  });

  test('rotate overwrites the token, reveals the new value once, and is effective without contain()', async () => {
    writeSecret(home(), HOST_EXTERNAL_MCP_TOKEN_SECRET, 'existing-token');

    const response = await handleRotateExternalMcpToken(deps());

    const body = response.body as { token: string; tokenHash: string };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).not.toBe('existing-token');
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBe(body.token);
    expect(containCalls).toEqual([]);
  });

  test('rotate refuses when external access was never enabled and no token exists', async () => {
    const response = await handleRotateExternalMcpToken(deps());

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain('external_mcp_not_enabled');
    expect(readSecrets(home())[HOST_EXTERNAL_MCP_TOKEN_SECRET]).toBeUndefined();
  });

  test('disable delegates to the containment authority and preserves the response shape', async () => {
    const response = await handlePutExternalMcpToggle(deps(), { enabled: false });

    expect(response).toEqual({ body: containmentResult });
    expect(containCalls).toEqual(['disable']);
  });

  test('a cross-process containment lock reports the stable busy refusal', async () => {
    const busy = deps();
    busy.externalMcp!.containment.contain = async () => {
      throw new ExternalMcpContainmentBusyError();
    };

    const response = await handlePutExternalMcpToggle(busy, { enabled: false });

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: 'external_mcp_busy',
          message: 'Another external MCP containment operation is already in progress.',
        },
      },
    });
  });

  test('invalid toggle input is rejected without entering containment', async () => {
    const response = await handlePutExternalMcpToggle(deps(), {});

    expect(response.status).toBe(400);
    expect(containCalls).toEqual([]);
  });

  test('an undesignated host still refuses before any external MCP operation', async () => {
    const noHost = {
      ...deps(),
      hostServe: null,
    };

    expect((await handlePutExternalMcpToggle(noHost, { enabled: true })).status).toBe(404);
    expect((await handleRotateExternalMcpToken(noHost)).status).toBe(404);
    expect(containCalls).toEqual([]);
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
    seedExternalMcpConfig(home(), { enabled: true, port: 8743 });

    expect(resolveExternalMcpCoherence(loadMachineConfig(home()), home())).toEqual({ kind: 'missing_token', port: 8743 });

    const { checkExternalMcpCoherence } = await import('@myco/cli/doctor');
    const check = await checkExternalMcpCoherence(home());
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('no access token exists');
  });

  test('enabled with a minted token -> ok, no doctor row', async () => {
    const { resolveExternalMcpCoherence } = await import('@myco/daemon/host-serve');
    seedExternalMcpConfig(home(), { enabled: true, port: 8743 });
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
      { hostServe: { bearer: 'b', servedGroveId: grove.id }, mycoHome: home() },
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
