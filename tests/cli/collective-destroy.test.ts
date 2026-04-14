import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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

describe('collectiveDestroy', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'myco-collective-destroy-'));
    originalHome = process.env.HOME;
    process.env.MYCO_HOME_OVERRIDE = tempDir;
    process.env.HOME = tempDir;
    execHandlers.length = 0;
    execCalls.length = 0;

    const configPath = path.join(tempDir, '.myco-collective', 'oss', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'oss',
      worker_url: 'https://oss.example.workers.dev',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 2,
      d1_database_id: 'db-uuid-123',
      kv_namespace_id: 'kv-namespace-456',
      deploy_dir: path.join(tempDir, '.myco-collective', 'oss', 'worker'),
      admin_token: 'admin-token',
      mcp_token: 'mcp-token',
    }), 'utf-8');
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.MYCO_HOME_OVERRIDE;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('preserves local retry state when remote teardown fails', async () => {
    execHandlers.push(
      () => new Error('worker delete exploded'),
      () => '',
      () => '',
    );

    const { collectiveDestroy } = await import('../../packages/myco-collective/src/cli.js');
    await expect(collectiveDestroy('oss')).rejects.toThrow('Local state preserved for retry');
    expect(fs.existsSync(path.join(tempDir, '.myco-collective', 'oss', 'config.json'))).toBe(true);
  });

  it('uses wrangler-compatible destroy arguments for D1 and KV cleanup', async () => {
    execHandlers.push(
      () => '',
      () => '',
      () => '',
    );

    const { collectiveDestroy } = await import('../../packages/myco-collective/src/cli.js');
    await collectiveDestroy('oss');

    expect(execCalls.map((call) => call.args)).toContainEqual(['delete', 'oss']);
    expect(execCalls.map((call) => call.args)).toContainEqual(['d1', 'delete', 'oss', '--skip-confirmation']);
    expect(execCalls.map((call) => call.args)).toContainEqual([
      'kv',
      'namespace',
      'delete',
      '--namespace-id',
      'kv-namespace-456',
      '--skip-confirmation',
    ]);
    expect(fs.existsSync(path.join(tempDir, '.myco-collective', 'oss', 'config.json'))).toBe(false);
  });
});
