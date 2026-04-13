import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execHandlers: Array<() => string | Error> = [];
const execCalls: Array<{ command: string; args: string[] }> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[] = []) => {
      execCalls.push({ command, args });
      const handler = execHandlers.shift();
      if (!handler) return '';
      const result = handler();
      if (result instanceof Error) throw result;
      return result;
    }),
  };
});

describe('teamDestroy', () => {
  let tempHomeDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-destroy-'));
    previousHome = process.env.HOME;
    process.env.HOME = tempHomeDir;
    execHandlers.length = 0;
    execCalls.length = 0;

    const configPath = path.join(tempHomeDir, '.myco-team', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      api_key: 'api-key',
      mcp_token: 'mcp-token',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
      vault_dir: '/tmp/fake-vault',
    }), 'utf-8');
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock('@myco-deploy/index.js');
  });

  it('preserves local retry state when remote teardown fails', async () => {
    execHandlers.push(
      () => new Error('worker delete exploded'),
      () => '',
      () => '[]',
      () => '[]',
    );

    vi.doMock('@myco-deploy/index.js', async () => {
      const actual = await vi.importActual<typeof import('@myco-deploy/index.js')>('@myco-deploy/index.js');
      return {
        ...actual,
        resolveHomeConfigPath: (configDir: string, fileName: string) => path.join(tempHomeDir, configDir, fileName),
      };
    });

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');

    await expect(teamDestroy()).rejects.toThrow('Local state preserved for retry');
    expect(fs.existsSync(path.join(tempHomeDir, '.myco-team', 'config.json'))).toBe(true);
  });

  it('uses the current wrangler destroy flags for remote teardown', async () => {
    execHandlers.push(
      () => '',
      () => '',
      () => JSON.stringify([{ name: 'myco-team-test', uuid: 'db-uuid-123' }]),
      () => '',
      () => JSON.stringify([{ id: 'kv-namespace-456', title: 'myco-team-test-secrets' }]),
      () => '',
    );

    vi.doMock('@myco-deploy/index.js', async () => {
      const actual = await vi.importActual<typeof import('@myco-deploy/index.js')>('@myco-deploy/index.js');
      return {
        ...actual,
        resolveHomeConfigPath: (configDir: string, fileName: string) => path.join(tempHomeDir, configDir, fileName),
      };
    });

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');
    await teamDestroy();

    expect(execCalls.map((call) => call.args)).toContainEqual(['delete', 'myco-team-test']);
    expect(execCalls.map((call) => call.args)).toContainEqual(['vectorize', 'delete', 'myco-team-test-vectors']);
    expect(execCalls.map((call) => call.args)).toContainEqual(['d1', 'delete', 'myco-team-test', '--skip-confirmation']);
    expect(execCalls.map((call) => call.args)).toContainEqual([
      'kv',
      'namespace',
      'delete',
      '--namespace-id',
      'kv-namespace-456',
      '--skip-confirmation',
    ]);
    expect(fs.existsSync(path.join(tempHomeDir, '.myco-team', 'config.json'))).toBe(false);
  });
});
