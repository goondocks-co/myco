import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execHandlers: Array<() => string | Error> = [];

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
    ...childProcessActual,
    execFileSync: vi.fn((_command: string, _args: string[], options?: { encoding?: string }) => {
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler();
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  }));

describe('teamRotateTokens', () => {
  let tempDir: string;
  let vaultDir: string;
  let fetchCalls: number;
  let originalExistsSync: typeof fs.existsSync;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-rotate-'));
    vaultDir = path.join(tempDir, 'project', '.myco');
    fetchCalls = 0;
    execHandlers.length = 0;
    originalExistsSync = fs.existsSync.bind(fs);

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      [
        '[project]',
        'id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        'name = "test"',
        '',
        '[grove]',
        'binding_id = "gbind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        'slug = "rotate-test"',
        'mode = "local"',
      ].join('\n') + '\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
      'team:',
      '  enabled: true',
      '  worker_url: https://myco-team-test.example.workers.dev',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=old-api-key\n', 'utf-8');

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

    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target) === path.join(vaultDir, 'myco.yaml')) return true;
      return originalExistsSync(target);
    });

    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls < 3) {
        return new Response('{"error":"Invalid Team key"}', {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{"token":"new-mcp-token"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
    execHandlers.length = 0;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists the new Team key before retrying MCP rotation', async () => {
    execHandlers.push(() => '');

    const { teamRotateTokens } = await import('../../packages/myco-team/src/cli.js');
    await teamRotateTokens(vaultDir, 'all');

    const expectedPackageVersion = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'packages', 'myco-team', 'package.json'), 'utf-8'),
    ) as { version: string };
    const localConfig = JSON.parse(fs.readFileSync(path.join(vaultDir, 'team', 'config.json'), 'utf-8')) as {
      package_version: string;
    };
    const secrets = fs.readFileSync(path.join(vaultDir, 'secrets.env'), 'utf-8');

    expect(localConfig.package_version).toBe(expectedPackageVersion.version);
    expect(secrets).toContain('MYCO_TEAM_API_KEY=');
    expect(secrets).not.toContain('MYCO_TEAM_API_KEY=old-api-key');
    expect(secrets).toContain('MYCO_TEAM_MCP_TOKEN=new-mcp-token');
    expect(fetchCalls).toBe(3);
  });
});
