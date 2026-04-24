import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

describe('createTeamHandlers.handleStatus', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
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
      cached_team_package_version: string | null;
      deployed_worker_version: string | null;
      worker_update_available: boolean;
      package_version: string;
    };

    expect(body.package_version).toBe(readPackageVersion('packages', 'myco', 'package.json'));
    expect(body.local_team_package_version).toBe(teamPackageJson.version);
    expect(body.cached_team_package_version).toBe('0.1.0');
    expect(body.deployed_worker_version).toBe('0.1.0');
    expect(body.worker_update_available).toBe(body.local_team_package_version !== body.deployed_worker_version);
  });
});
