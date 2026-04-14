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
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-destroy-'));
    vaultDir = path.join(tempDir, 'project', '.myco');
    execHandlers.length = 0;
    execCalls.length = 0;

    const configPath = path.join(vaultDir, 'team', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      package_version: '0.1.1',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
    }), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=api-key\n', 'utf-8');
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
      () => '[]',
      () => '[]',
    );

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');

    await expect(teamDestroy(vaultDir)).rejects.toThrow('Local state preserved for retry');
    expect(fs.existsSync(path.join(vaultDir, 'team', 'config.json'))).toBe(true);
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

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');
    await teamDestroy(vaultDir);

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
    expect(fs.existsSync(path.join(vaultDir, 'team', 'config.json'))).toBe(false);
  });
});
