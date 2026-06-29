import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRegistry } from '@myco/team/registry';

const execHandlers: Array<() => string | Error> = [];
const TEAM_ID = `team_${'a'.repeat(32)}`;

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
  let fetchCalls: number;
  let originalMycoHome: string | undefined;
  let originalTeamHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-rotate-'));
    fetchCalls = 0;
    execHandlers.length = 0;
    originalMycoHome = process.env.MYCO_HOME;
    originalTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = path.join(tempDir, 'home');
    process.env.MYCO_TEAM_HOME = path.join(tempDir, 'home');

    teamRegistry.saveDeployment({
      team_id: TEAM_ID,
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      package_version: '0.1.0',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
    });
    teamRegistry.save({
      team_id: TEAM_ID,
      name: 'Rotate Team',
      worker_url: 'https://myco-team-test.example.workers.dev',
      domain: null,
      mcp_endpoint: 'https://myco-team-test.example.workers.dev/mcp',
      created_at: new Date().toISOString(),
      projects: [],
    });
    teamRegistry.writeSecret(TEAM_ID, 'MYCO_TEAM_API_KEY', 'old-api-key');

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
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    if (originalTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = originalTeamHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists the new Team key before retrying MCP rotation', async () => {
    execHandlers.push(() => '');

    const { teamRotateTokens } = await import('../../packages/myco-team/src/cli.js');
    await teamRotateTokens('all', { teamId: TEAM_ID });

    const deployment = teamRegistry.readDeployment(TEAM_ID);
    const secrets = teamRegistry.readSecrets(TEAM_ID);

    // Key rotation is not a redeploy — the recorded worker version stays as
    // deployed (seeded '0.1.0'), it is not bumped to the running package version.
    expect(deployment?.package_version).toBe('0.1.0');
    expect(secrets.MYCO_TEAM_API_KEY).toBeDefined();
    expect(secrets.MYCO_TEAM_API_KEY).not.toBe('old-api-key');
    expect(secrets.MYCO_TEAM_MCP_TOKEN).toBe('new-mcp-token');
    expect(fetchCalls).toBe(3);
  });
});
