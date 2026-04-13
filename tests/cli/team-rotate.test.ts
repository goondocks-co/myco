import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execHandlers: Array<() => string | Error> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn((_command: string, _args: string[], options?: { encoding?: string }) => {
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler();
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  };
});

describe('teamRotateTokens', () => {
  let tempHomeDir: string;
  let vaultDir: string;
  let previousHome: string | undefined;
  let fetchCalls: number;
  let originalExistsSync: typeof fs.existsSync;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-rotate-'));
    vaultDir = path.join(tempHomeDir, 'project', '.myco');
    previousHome = process.env.HOME;
    process.env.HOME = tempHomeDir;
    fetchCalls = 0;
    execHandlers.length = 0;
    originalExistsSync = fs.existsSync.bind(fs);

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
      'team:',
      '  enabled: true',
      '  worker_url: https://myco-team-test.example.workers.dev',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=old-api-key\n', 'utf-8');

    const configPath = path.join(tempHomeDir, '.myco-team', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      api_key: 'old-api-key',
      mcp_token: 'old-mcp-token',
      package_version: '0.1.0',
      vault_dir: vaultDir,
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
        return new Response('{"error":"Invalid API key"}', {
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

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('persists the new API key before retrying MCP rotation', async () => {
    execHandlers.push(() => '');

    vi.doMock('@myco-deploy/index.js', async () => {
      const actual = await vi.importActual<typeof import('@myco-deploy/index.js')>('@myco-deploy/index.js');
      return {
        ...actual,
        resolveHomeConfigPath: (configDir: string, fileName: string) => path.join(tempHomeDir, configDir, fileName),
      };
    });

    const { teamRotateTokens } = await import('../../packages/myco-team/src/cli.js');
    await teamRotateTokens('all');

    const localConfig = JSON.parse(fs.readFileSync(path.join(tempHomeDir, '.myco-team', 'config.json'), 'utf-8')) as {
      api_key: string;
      mcp_token: string | null;
      package_version: string;
    };
    const secrets = fs.readFileSync(path.join(vaultDir, 'secrets.env'), 'utf-8');

    expect(localConfig.api_key).not.toBe('old-api-key');
    expect(localConfig.mcp_token).toBe('new-mcp-token');
    expect(localConfig.package_version).toBe('0.1.0');
    expect(secrets).toContain(`MYCO_TEAM_API_KEY=${localConfig.api_key}`);
    expect(fetchCalls).toBe(3);
  });
});
