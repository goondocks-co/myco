import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRegistry } from '@myco/team/registry';

const execCalls: Array<{ command: string; args: string[] }> = [];
const execHandlers: Array<(args: string[]) => string | Error> = [];

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
    ...childProcessActual,
    execFileSync: vi.fn((command: string, args: string[] = [], options?: { encoding?: string }) => {
      execCalls.push({ command, args });
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler(args);
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  }));

const TEAM_ID = `team_${'d'.repeat(32)}`;
const WORKER_URL = 'https://myco-team-acme-oss-deadbeef.test.workers.dev';

describe('teamAdopt', () => {
  let tempDir: string;
  let connectCalls: number;
  let rotateCalls: number;
  let originalMycoHome: string | undefined;
  let originalTeamHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-adopt-'));
    execCalls.length = 0;
    execHandlers.length = 0;
    connectCalls = 0;
    rotateCalls = 0;
    originalMycoHome = process.env.MYCO_HOME;
    originalTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = path.join(tempDir, 'home');
    process.env.MYCO_TEAM_HOME = path.join(tempDir, 'home');

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith('/connect')) {
        connectCalls += 1;
        return new Response(JSON.stringify({
          status: 'connected',
          config: { team_id: TEAM_ID, team_name: 'Acme OSS', created_at: '1782000000' },
          mcp_token: 'connect-mcp-token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (target.endsWith('/mcp/rotate')) {
        rotateCalls += 1;
        return new Response(JSON.stringify({ token: 'rotated-mcp-token' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    if (originalTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = originalTeamHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reconstructs local state from a live worker using a supplied api key (no key regeneration, no rotate)', async () => {
    const { teamAdopt } = await import('../../packages/myco-team/src/cli.js');
    await teamAdopt({ workerUrl: WORKER_URL, apiKey: 'existing-key' });

    // Supplying the key means no key regeneration (`wrangler secret put`) and
    // no destructive rotate — the MCP token /connect returned is reused.
    // (getMachineId may shell out to `git` once, so we assert on the absence of
    // the secret-put rather than an empty execCalls list.)
    expect(execCalls.find((c) => c.args[0] === 'secret' && c.args[1] === 'put')).toBeUndefined();
    expect(connectCalls).toBe(1);
    expect(rotateCalls).toBe(0);

    const team = teamRegistry.get(TEAM_ID);
    expect(team?.name).toBe('Acme OSS');
    expect(team?.worker_url).toBe(WORKER_URL);
    expect(team?.domain).toBeNull();
    expect(team?.projects).toEqual([]);

    const secrets = teamRegistry.readSecrets(TEAM_ID);
    expect(secrets.MYCO_TEAM_API_KEY).toBe('existing-key');
    expect(secrets.MYCO_TEAM_MCP_TOKEN).toBe('connect-mcp-token');
    expect(teamRegistry.readDeployment(TEAM_ID)?.worker_name).toBe('myco-team-acme-oss-deadbeef');
  });

  it('regenerates the team key via wrangler when no api key is supplied', async () => {
    // ensureWranglerReady: --version, whoami; then secret put.
    execHandlers.push(
      () => 'wrangler 4.8.1\n',
      () => 'logged in\n',
      () => '',
    );
    const { teamAdopt } = await import('../../packages/myco-team/src/cli.js');
    await teamAdopt({ workerUrl: WORKER_URL });

    const secretPut = execCalls.find((c) => c.args[0] === 'secret' && c.args[1] === 'put');
    expect(secretPut).toBeDefined();
    expect(secretPut!.args).toContain('--name');
    // Worker name derived from the *.workers.dev host.
    expect(secretPut!.args).toContain('myco-team-acme-oss-deadbeef');

    // A fresh 64-hex-char key was generated and stored locally.
    const stored = teamRegistry.readSecrets(TEAM_ID).MYCO_TEAM_API_KEY;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects adoption without a worker url', async () => {
    const { teamAdopt } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamAdopt({})).rejects.toThrow(/worker-url/);
  });

  it('reuses a locally-stored key instead of regenerating when none is supplied', async () => {
    const { teamRegistry } = await import('@myco/team/registry');
    teamRegistry.save({
      team_id: TEAM_ID, name: 'Acme OSS', worker_url: WORKER_URL, domain: null,
      mcp_endpoint: `${WORKER_URL}/mcp`, created_at: '2026-06-28T00:00:00Z', projects: [],
    });
    teamRegistry.writeSecret(TEAM_ID, 'MYCO_TEAM_API_KEY', 'pre-existing-key');

    const { teamAdopt } = await import('../../packages/myco-team/src/cli.js');
    await teamAdopt({ workerUrl: WORKER_URL });   // no --api-key

    // No key regeneration — no `wrangler secret put` — the stored key is reused.
    expect(execCalls.find((c) => c.args[0] === 'secret' && c.args[1] === 'put')).toBeUndefined();
    expect(connectCalls).toBe(1);
    expect(teamRegistry.readSecrets(TEAM_ID).MYCO_TEAM_API_KEY).toBe('pre-existing-key');
  });

  it('refuses a non-https worker url before sending the key', async () => {
    const { teamAdopt } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamAdopt({ workerUrl: 'http://myco-team-x.example.workers.dev', apiKey: 'k' }))
      .rejects.toThrow(/https/);
    expect(connectCalls).toBe(0);
  });
});
