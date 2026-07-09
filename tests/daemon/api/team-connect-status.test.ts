import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

function readPackageVersion(...segments: string[]): string {
  const filePath = path.join(process.cwd(), ...segments);
  const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { version: string };
  return packageJson.version;
}

/**
 * Build a fake npm global prefix directory layout on disk so
 * `getInstalledVersion(prefix, '@goondocks/myco-team')` resolves the
 * expected test version without requiring an actual global install.
 */
function makeFakeGlobalPrefix(root: string, teamPackageVersion: string): string {
  const prefix = path.join(root, 'npm-prefix');
  const teamPkgDir = path.join(prefix, 'lib', 'node_modules', '@goondocks', 'myco-team');
  fs.mkdirSync(teamPkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamPkgDir, 'package.json'),
    JSON.stringify({ name: '@goondocks/myco-team', version: teamPackageVersion }, null, 2),
    'utf-8',
  );
  return prefix;
}

function makeFakeDevLinkedTeamBinary(root: string, teamPackageVersion: string): string {
  const packageRoot = path.join(root, 'packages', 'myco-team');
  const distDir = path.join(packageRoot, 'dist');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@goondocks/myco-team', version: teamPackageVersion }, null, 2),
    'utf-8',
  );
  const entry = path.join(distDir, 'main.js');
  fs.writeFileSync(entry, '#!/usr/bin/env node\n', 'utf-8');
  fs.symlinkSync(entry, path.join(binDir, 'myco-team-dev'));
  return binDir;
}

describe('createTeamHandlers.handleStatus', () => {
  let tempDir: string;
  let vaultDir: string;
  let originalPath: string | undefined;
  let originalMycoHome: string | undefined;

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    originalPath = process.env.PATH;
    originalMycoHome = process.env.MYCO_HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-status-'));
    // Sandbox MYCO_HOME so the v8 merged-config loader doesn't pick up
    // the dev machine's Grove tier and drop the project-tier `team:` block.
    process.env.MYCO_HOME = path.join(tempDir, '.myco-home');
    process.env.MYCO_TEAM_HOME = path.join(tempDir, '.myco-team-home');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
    vaultDir = path.join(tempDir, 'project', '.myco');

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
      'team:',
      '  enabled: true',
      '  worker_url: https://myco-team-test.example.workers.dev',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=test-api-key\n', 'utf-8');

    const configPath = path.join(vaultDir, 'team', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      package_version: '0.1.0',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
    }, null, 2), 'utf-8');
  });

  afterEach(() => {
    vi.resetModules();
    process.env.PATH = originalPath;
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    delete process.env.MYCO_TEAM_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('compares deployed worker version against installed myco-team version', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');
    const { teamRegistry } = await import('../../../packages/myco/src/team/registry.js');
    const { createTeamId, createProjectId } = await import('../../../packages/myco/src/grove/ids.js');
    const teamPackageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'packages', 'myco-team', 'package.json'), 'utf-8'),
    ) as { version: string };
    // Stage a fake npm global prefix that holds the expected myco-team
    // version. The daemon now reads the locally-installed version from
    // `<prefix>/lib/node_modules/@goondocks/myco-team/package.json` via
    // `getInstalledVersion` rather than importing myco-team's code.
    const globalPrefix = makeFakeGlobalPrefix(tempDir, teamPackageJson.version);

    // Phase 2.3: `enabled` + the worker-version probe now gate on REGISTRY
    // participation, not the grove-config flag. Register a team for this
    // request's project so participation is true and `health()` runs.
    const mycoHome = process.env.MYCO_HOME!;
    const { resolveGroveDir } = await import('../../../packages/myco/src/grove/paths.js');
    const grove = createGrove('Version Test Grove', mycoHome);
    const projectId = createProjectId();
    const teamId = createTeamId();
    teamRegistry.save({
      team_id: teamId,
      name: 'Version Team',
      worker_url: 'https://myco-team-test.example.workers.dev',
      domain: null,
      mcp_endpoint: null,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId }],
    });
    // has_team_key / team_key now come from the selected Team's registry
    // secrets, not the retired per-Grove connection store.
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'test-api-key');
    const groveDir = resolveGroveDir(grove.id, mycoHome);
    fs.mkdirSync(groveDir, { recursive: true });
    // cached_team_package_version reads the team/config.json under the resolved
    // store's configDir, which is the Grove dir under a Grove context.
    const groveTeamConfig = path.join(groveDir, 'team', 'config.json');
    fs.mkdirSync(path.dirname(groveTeamConfig), { recursive: true });
    fs.writeFileSync(groveTeamConfig, JSON.stringify({
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      package_version: '0.1.0',
    }, null, 2), 'utf-8');

    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getTeamClient: () => ({
        health: async () => ({
          status: 'ok',
          node_count: 1,
          sync_protocol_version: 1,
          package_version: '0.1.0',
          schema_version: 12,
        }),
        getCollectiveStatus: async () => ({
          connected: false,
          collective_url: null,
          project_id: null,
          last_settings_sync: null,
          last_heartbeat: null,
          capabilities: [],
          settings: {},
        }),
        getConfig: async () => ({ config: {}, sync_protocol_version: 1 }),
        getVersionCompat: () => 'ok',
        getWorkerProtocolVersion: () => 1,
        getWorkerMinClientVersion: () => 1,
        getMcpToken: () => null,
        getMcpEndpoint: () => null,
      }) as never,
    });

    const response = await handlers.handleStatus({
      requestContext: {
        projectRoot: path.join(tempDir, 'project'),
        projectVaultDir: vaultDir,
        projectId,
        groveId: grove.id,
        machineId: 'machine-test',
        sessionId: null,
        databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
        source: 'headers',
      },
    } as never);
    const body = response.body as {
      enabled: boolean;
      worker_url: string | null;
      local_team_package_version: string | null;
      local_team_package_source: string | null;
      cached_team_package_version: string | null;
      deployed_worker_version: string | null;
      worker_update_available: boolean;
      package_version: string;
      has_team_key: boolean;
      team_key: string | null;
      has_api_key: boolean;
      api_key: string | null;
    };

    expect(body.package_version).toBe(readPackageVersion('packages', 'myco', 'package.json'));
    // enabled now reflects registry participation; worker_url is sourced from
    // the resolved team's registry record.
    expect(body.enabled).toBe(true);
    expect(body.worker_url).toBe('https://myco-team-test.example.workers.dev');
    expect(body.has_team_key).toBe(true);
    // team_key is surfaced again (like mcp_token) so the Team Credentials
    // card can reveal it for sharing; redaction happens client-side.
    expect(body.team_key).toBe('test-api-key');
    expect(body.has_api_key).toBe(true);
    expect(body.api_key).toBeNull();
    expect(body.local_team_package_version).toBe(teamPackageJson.version);
    expect(body.local_team_package_source).toBe('installed');
    expect(body.cached_team_package_version).toBe('0.1.0');
    expect(body.deployed_worker_version).toBe('0.1.0');
    expect(body.worker_update_available).toBe(body.local_team_package_version !== body.deployed_worker_version);
  });

  it('surfaces version_status and protocol bounds when the worker advertises an incompatible floor', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');
    const { teamRegistry } = await import('../../../packages/myco/src/team/registry.js');
    const { createTeamId, createProjectId } = await import('../../../packages/myco/src/grove/ids.js');
    const { resolveGroveDir } = await import('../../../packages/myco/src/grove/paths.js');

    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove('Version Floor Grove', mycoHome);
    const projectId = createProjectId();
    const teamId = createTeamId();
    teamRegistry.save({
      team_id: teamId,
      name: 'Version Floor Team',
      worker_url: 'https://myco-team-test.example.workers.dev',
      domain: null,
      mcp_endpoint: null,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId }],
    });
    const groveDir = resolveGroveDir(grove.id, mycoHome);
    fs.mkdirSync(groveDir, { recursive: true });
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'test-api-key');

    // Client whose health() probe populated incompatible bounds: worker speaks
    // protocol 3 and floors clients at 2; this daemon is older → client_too_old.
    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix: null,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      getTeamClient: () => ({
        health: async () => ({
          status: 'ok',
          node_count: 1,
          sync_protocol_version: 3,
          min_compat_client_version: 2,
        }),
        getCollectiveStatus: async () => ({
          connected: false, collective_url: null, project_id: null,
          last_settings_sync: null, last_heartbeat: null, capabilities: [], settings: {},
        }),
        getConfig: async () => ({ config: {}, sync_protocol_version: 3 }),
        getVersionCompat: () => 'client_too_old',
        getWorkerProtocolVersion: () => 3,
        getWorkerMinClientVersion: () => 2,
        getMcpToken: () => null,
        getMcpEndpoint: () => null,
      }) as never,
    });

    const response = await handlers.handleStatus({
      requestContext: {
        projectRoot: path.join(tempDir, 'project'),
        projectVaultDir: vaultDir,
        projectId,
        groveId: grove.id,
        machineId: 'machine-test',
        sessionId: null,
        databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
        source: 'headers',
      },
    } as never);
    const body = response.body as {
      version_status: string;
      daemon_protocol_version: number;
      worker_protocol_version: number | null;
      worker_min_client_version: number | null;
      reconcile_gated_tables: string[];
    };

    expect(body.version_status).toBe('client_too_old');
    expect(body.worker_protocol_version).toBe(3);
    expect(body.worker_min_client_version).toBe(2);
    expect(body.daemon_protocol_version).toBeGreaterThan(0);
    // Worker at protocol 3 serves every synced table — nothing gated.
    expect(body.reconcile_gated_tables).toEqual([]);
  });

  it('surfaces reconcile_gated_tables when the worker predates newer synced tables', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');
    const { teamRegistry } = await import('../../../packages/myco/src/team/registry.js');
    const { createTeamId, createProjectId } = await import('../../../packages/myco/src/grove/ids.js');
    const { resolveGroveDir } = await import('../../../packages/myco/src/grove/paths.js');

    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove('Partial Skew Grove', mycoHome);
    const projectId = createProjectId();
    const teamId = createTeamId();
    teamRegistry.save({
      team_id: teamId,
      name: 'Partial Skew Team',
      worker_url: 'https://myco-team-test.example.workers.dev',
      domain: null,
      mcp_endpoint: null,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId }],
    });
    const groveDir = resolveGroveDir(grove.id, mycoHome);
    fs.mkdirSync(groveDir, { recursive: true });
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'test-api-key');

    // The partial-degradation middle state: the worker ACCEPTS this client
    // (sync not paused) but its deployment predates the protocol-3 tables,
    // so reconcile skips them. The status payload must disclose exactly
    // which tables — from the same helper the reconcile gate uses.
    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix: null,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      getTeamClient: () => ({
        health: async () => ({
          status: 'ok',
          node_count: 1,
          sync_protocol_version: 2,
          min_compat_client_version: 1,
        }),
        getCollectiveStatus: async () => ({
          connected: false, collective_url: null, project_id: null,
          last_settings_sync: null, last_heartbeat: null, capabilities: [], settings: {},
        }),
        getConfig: async () => ({ config: {}, sync_protocol_version: 2 }),
        getVersionCompat: () => 'ok',
        getWorkerProtocolVersion: () => 2,
        getWorkerMinClientVersion: () => 1,
        getMcpToken: () => null,
        getMcpEndpoint: () => null,
      }) as never,
    });

    const response = await handlers.handleStatus({
      requestContext: {
        projectRoot: path.join(tempDir, 'project'),
        projectVaultDir: vaultDir,
        projectId,
        groveId: grove.id,
        machineId: 'machine-test',
        sessionId: null,
        databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
        source: 'headers',
      },
    } as never);
    const body = response.body as {
      version_status: string;
      reconcile_gated_tables: string[];
    };

    expect(body.version_status).toBe('ok');
    expect(new Set(body.reconcile_gated_tables)).toEqual(
      new Set(['skill_lineage', 'okf_generations', 'okf_pages', 'okf_page_revisions']),
    );
  });

  it('reports enabled=false when the Grove participates in no team (registry gate)', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    // A Grove with no team membership in the registry — even though the
    // grove-config still carries `team.enabled: true`, participation is the
    // source of truth, so `enabled` is false and no worker probe runs.
    const grove = createGrove('Orphan Grove', mycoHome);
    const healthSpy = vi.fn();
    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix: null,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      getTeamClient: () => ({
        health: healthSpy,
        getVersionCompat: () => 'unknown',
        getWorkerProtocolVersion: () => undefined,
        getWorkerMinClientVersion: () => undefined,
        getMcpToken: () => 'should-not-surface',
        getMcpEndpoint: () => 'https://x/mcp',
      }) as never,
    });

    const response = await handlers.handleStatus({
      requestContext: {
        projectRoot: path.join(tempDir, 'project'),
        projectVaultDir: vaultDir,
        projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        groveId: grove.id,
        machineId: 'machine-test',
        sessionId: null,
        databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
        source: 'headers',
      },
    } as never);
    const body = response.body as { enabled: boolean; worker_url: string | null };

    expect(body.enabled).toBe(false);
    // No participation → no worker probe.
    expect(healthSpy).not.toHaveBeenCalled();
  });

  it('falls back to a team the Grove participates in when the request project maps to no team (no team_id)', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');
    const { teamRegistry } = await import('../../../packages/myco/src/team/registry.js');
    const { createTeamId } = await import('../../../packages/myco/src/grove/ids.js');
    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove('Multi-Project Grove', mycoHome);
    const teamId = createTeamId();
    // The team is participated-in by the grove via a DIFFERENT project than the
    // one on the request — mirrors a multi-project grove / brief initial load.
    teamRegistry.save({
      team_id: teamId,
      name: 'Grove Team',
      worker_url: 'https://grove-team.example.workers.dev',
      domain: null,
      mcp_endpoint: 'https://grove-team.example.workers.dev/mcp',
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: 'proj_cccccccccccccccccccccccccccccccc' }],
    });

    const healthSpy = vi.fn(async () => ({
      status: 'ok', node_count: 1, sync_protocol_version: 1, package_version: '1.2.3', schema_version: 1,
    }));
    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix: null,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      // Project-context client must NOT be used; the grove fallback resolves via id.
      getTeamClient: () => null,
      getTeamClientForId: (id: string) => (id === teamId ? ({
        health: healthSpy,
        getVersionCompat: () => 'ok',
        getWorkerProtocolVersion: () => 1,
        getWorkerMinClientVersion: () => 1,
        getMcpToken: () => null,
        getMcpEndpoint: () => null,
        getCollectiveStatus: async () => ({ connected: false, collective_url: null, project_id: null, last_settings_sync: null, last_heartbeat: null, capabilities: [], settings: {} }),
        getConfig: async () => ({ config: {}, sync_protocol_version: 1 }),
      }) : null),
    } as never);

    const response = await handlers.handleStatus({
      requestContext: {
        projectRoot: path.join(tempDir, 'project'),
        projectVaultDir: vaultDir,
        // A project that is NOT a member of any team.
        projectId: 'proj_dddddddddddddddddddddddddddddddd',
        groveId: grove.id,
        machineId: 'machine-test',
        sessionId: null,
        databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
        source: 'headers',
      },
    } as never);
    const body = response.body as { enabled: boolean; team_id: string | null; worker_url: string | null; healthy: boolean };

    expect(body.team_id).toBe(teamId);
    expect(body.worker_url).toBe('https://grove-team.example.workers.dev');
    expect(body.enabled).toBe(true);
    expect(body.healthy).toBe(true);
    expect(healthSpy).toHaveBeenCalled();
  });

  it('falls back to the dev-linked myco-team-dev binary when the global package is absent', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const binDir = makeFakeDevLinkedTeamBinary(tempDir, '9.8.7');
    process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);

    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix: null,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getTeamClient: () => null,
    });

    const response = await handlers.handleStatus({} as never);
    const body = response.body as {
      local_team_package_version: string | null;
      local_team_package_source: string | null;
    };

    expect(body.local_team_package_version).toBe('9.8.7');
    expect(body.local_team_package_source).toBe('dev-linked');
  });

  it('reports the selected Grove context for Grove-scoped callers', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');

    // Register a real Grove under a scoped MYCO_HOME so the assertion
    // exercises the same Grove status path users hit.
    const mycoHome = path.join(tempDir, 'home');
    const previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    try {
      const grove = createGrove('Status Test Grove', mycoHome);
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        getTeamClient: (requestContext) => {
          expect(requestContext?.groveId).toBe(grove.id);
          expect(requestContext?.projectId).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          return null;
        },
      });

      const response = await handlers.handleStatus({
        requestContext: {
          projectRoot: path.join(tempDir, 'project'),
          projectVaultDir: vaultDir,
          projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          groveId: grove.id,
          machineId: 'machine-test',
          sessionId: null,
          databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
          source: 'headers',
        },
      } as never);
      const body = response.body as {
        connection_scope: string;
        grove: { id: string; name: string; slug: string } | null;
        project: { id: string; name: string; root: string };
      };

      expect(body.connection_scope).toBe('grove');
      expect(body.grove).toMatchObject({ id: grove.id });
      expect(body.project).toMatchObject({ id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'project' });
    } finally {
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
    }
  });

  it('reports local and remote sync summary counts', async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('session-1', 'codex', 10, 10, 'machine-test');
    db.prepare(
      `INSERT INTO team_outbox (table_name, row_id, payload, machine_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('sessions', 'session-1', '{}', 'machine-test', 10);
    db.prepare(
      `INSERT INTO log_entries (timestamp, level, kind, component, message, data, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '2026-05-06T13:13:33.000Z',
      'info',
      LOG_KINDS.TEAM_SYNC_HANDOFF,
      'team-sync',
      'Team sync handoff complete',
      JSON.stringify({ mode: 'all', enqueued: 1, flushed: 1, rejected: 0, batches: 1, duration_ms: 120 }),
      null,
    );

    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
      globalPrefix: null,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getTeamClient: () => ({
        getSyncSummary: async () => ({
          generated_at: 1778060000,
          total_records: 1,
          tables: { sessions: 1 },
          schema_version: 35,
          package_version: '0.1.7',
          sync_protocol_version: 1,
        }),
      }) as never,
    });

    const response = await handlers.handleSyncSummary({} as never);
    const body = response.body as {
      local: { total_records: number; pending_sync_count: number; tables: Record<string, number> };
      remote: { total_records: number; tables: Record<string, number> } | null;
      last_handoff: { accepted: number; batches: number; duration_ms: number | null } | null;
    };

    expect(body.local.tables.sessions).toBe(1);
    expect(body.local.pending_sync_count).toBe(1);
    expect(body.remote?.total_records).toBe(1);
    expect(body.last_handoff).toMatchObject({ accepted: 1, batches: 1, duration_ms: 120 });
  });
});
