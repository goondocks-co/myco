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

describe('collectiveDestroy', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-collective-destroy-'));
    vaultDir = path.join(tempDir, 'project', '.myco');
    execHandlers.length = 0;
    execCalls.length = 0;

    const configPath = path.join(vaultDir, 'collective', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'myco-collective-test',
      worker_url: 'https://myco-collective-test.example.workers.dev',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 2,
      d1_database_id: 'db-uuid-123',
      kv_namespace_id: 'kv-namespace-456',
      deploy_dir: path.join(vaultDir, 'collective', 'worker'),
    }), 'utf-8');
    fs.writeFileSync(
      path.join(vaultDir, 'secrets.env'),
      'MYCO_COLLECTIVE_ADMIN_TOKEN=admin-token\nMYCO_COLLECTIVE_MCP_TOKEN=mcp-token\n',
      'utf-8',
    );
  });

  afterEach(() => {
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
    await expect(collectiveDestroy(vaultDir)).rejects.toThrow('Local state preserved for retry');
    expect(fs.existsSync(path.join(vaultDir, 'collective', 'config.json'))).toBe(true);
  });

  it('uses wrangler-compatible destroy arguments for D1 and KV cleanup', async () => {
    execHandlers.push(
      () => '',
      () => '',
      () => '',
    );

    const { collectiveDestroy } = await import('../../packages/myco-collective/src/cli.js');
    await collectiveDestroy(vaultDir);

    expect(execCalls.map((call) => call.args)).toContainEqual(['delete', 'myco-collective-test']);
    expect(execCalls.map((call) => call.args)).toContainEqual(['d1', 'delete', 'myco-collective-test', '--skip-confirmation']);
    expect(execCalls.map((call) => call.args)).toContainEqual([
      'kv',
      'namespace',
      'delete',
      '--namespace-id',
      'kv-namespace-456',
      '--skip-confirmation',
    ]);
    expect(fs.existsSync(path.join(vaultDir, 'collective', 'config.json'))).toBe(false);
  });
});
