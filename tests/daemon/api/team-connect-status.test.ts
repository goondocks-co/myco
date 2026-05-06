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

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    originalPath = process.env.PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-status-'));
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('compares deployed worker version against installed myco-team version', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const teamPackageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'packages', 'myco-team', 'package.json'), 'utf-8'),
    ) as { version: string };
    // Stage a fake npm global prefix that holds the expected myco-team
    // version. The daemon now reads the locally-installed version from
    // `<prefix>/lib/node_modules/@goondocks/myco-team/package.json` via
    // `getInstalledVersion` rather than importing myco-team's code.
    const globalPrefix = makeFakeGlobalPrefix(tempDir, teamPackageJson.version);
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
        getMcpToken: () => null,
        getMcpEndpoint: () => null,
      }) as never,
      setTeamClient: () => undefined,
    });

    const response = await handlers.handleStatus({} as never);
    const body = response.body as {
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
    expect(body.has_team_key).toBe(true);
    expect(body.team_key).toBe('test-api-key');
    expect(body.has_api_key).toBe(true);
    expect(body.api_key).toBeNull();
    expect(body.local_team_package_version).toBe(teamPackageJson.version);
    expect(body.local_team_package_source).toBe('installed');
    expect(body.cached_team_package_version).toBe('0.1.0');
    expect(body.deployed_worker_version).toBe('0.1.0');
    expect(body.worker_update_available).toBe(body.local_team_package_version !== body.deployed_worker_version);
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
      setTeamClient: () => undefined,
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
        expect(requestContext?.groveId).toBe('grove_test');
        expect(requestContext?.projectId).toBe('proj_test');
        return null;
      },
      setTeamClient: () => undefined,
    });

    const response = await handlers.handleStatus({
      requestContext: {
        projectRoot: path.join(tempDir, 'project'),
        projectVaultDir: vaultDir,
        projectId: 'proj_test',
        groveId: 'grove_test',
        machineId: 'machine-test',
        sessionId: null,
        databasePath: path.join(tempDir, 'home', 'groves', 'grove_test', 'myco.db'),
        source: 'headers',
      },
    } as never);
    const body = response.body as {
      connection_scope: string;
      grove: { id: string; name: string; slug: string } | null;
      project: { id: string; name: string; root: string };
    };

    expect(body.connection_scope).toBe('grove');
    expect(body.grove).toMatchObject({ id: 'grove_test' });
    expect(body.project).toMatchObject({ id: 'proj_test', name: 'project' });
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
      setTeamClient: () => undefined,
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
