import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRegistry } from '@myco/team/registry';

const execHandlers: Array<() => string | Error> = [];
const execCalls: Array<{ command: string; args: string[] }> = [];
const TEAM_ID = `team_${'b'.repeat(32)}`;

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
    ...childProcessActual,
    execFileSync: vi.fn((command: string, args: string[] = []) => {
      execCalls.push({ command, args });
      const handler = execHandlers.shift();
      if (!handler) return '';
      const result = handler();
      if (result instanceof Error) throw result;
      return result;
    }),
  }));

describe('teamDestroy', () => {
  let tempDir: string;
  let vaultDir: string;
  let originalMycoHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-destroy-'));
    vaultDir = path.join(tempDir, 'project', '.myco');
    execHandlers.length = 0;
    execCalls.length = 0;
    originalMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(tempDir, 'home');

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "destroy-test"\n',
      'utf-8',
    );
    teamRegistry.saveDeployment({
      team_id: TEAM_ID,
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      package_version: '0.1.1',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
    });
    teamRegistry.save({
      team_id: TEAM_ID,
      name: 'Destroy Team',
      worker_url: 'https://myco-team-test.example.workers.dev',
      domain: null,
      mcp_endpoint: 'https://myco-team-test.example.workers.dev/mcp',
      created_at: new Date().toISOString(),
      projects: [],
    });
    teamRegistry.writeSecret(TEAM_ID, 'MYCO_TEAM_API_KEY', 'api-key');
  });

  afterEach(() => {
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
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

    await expect(teamDestroy(vaultDir, { teamId: TEAM_ID })).rejects.toThrow('Local state preserved for retry');
    expect(teamRegistry.readDeployment(TEAM_ID, path.join(tempDir, 'home'))).not.toBeNull();
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
    await teamDestroy(vaultDir, { teamId: TEAM_ID });

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
    expect(teamRegistry.readDeployment(TEAM_ID, path.join(tempDir, 'home'))).toBeNull();
    expect(teamRegistry.get(TEAM_ID, path.join(tempDir, 'home'))).toBeNull();
  });
});
