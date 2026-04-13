import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTeamHandlers } from '../../../packages/myco/src/daemon/api/team-connect.js';

describe('createTeamHandlers.handleStatus', () => {
  let tempHomeDir: string;
  let vaultDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-status-'));
    vaultDir = path.join(tempHomeDir, 'project', '.myco');
    previousHome = process.env.HOME;
    process.env.HOME = tempHomeDir;

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
      'team:',
      '  enabled: true',
      '  worker_url: https://myco-team-test.example.workers.dev',
      '  deployed_worker_version: 0.1.0',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=test-api-key\n', 'utf-8');

    const configPath = path.join(tempHomeDir, '.myco-team', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      api_key: 'test-api-key',
      mcp_token: 'test-mcp-token',
      package_version: '0.1.0',
      vault_dir: vaultDir,
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
    }, null, 2), 'utf-8');
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('compares deployed worker version against installed myco-team version', async () => {
    const handlers = createTeamHandlers({
      vaultDir,
      machineId: 'machine-test',
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
      installed_team_package_version: string | null;
      deployed_worker_version: string | null;
      worker_update_available: boolean;
      package_version: string;
    };

    expect(body.package_version).toBe('0.18.1');
    expect(body.installed_team_package_version).toBe('0.1.0');
    expect(body.deployed_worker_version).toBe('0.1.0');
    expect(body.worker_update_available).toBe(false);
  });
});
