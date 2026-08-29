/**
 * The member tool surface, end to end: a real self-hosted Deployment on this
 * machine's loopback, the real stdio bridge spawned as an agent spawns it
 * (`myco mcp --credential env`), and the real CLI (`myco tool … --credential
 * env`). What an agent sees through the bridge is what the CLI sees, and both
 * are what the Deployment serves.
 *
 * The bridge never refreshes the credential: a refresh inserts a successor
 * credential, and the store holds exactly the one issued here throughout.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '@myco/member/credential.js';

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const CLI = path.resolve('packages/myco/src/cli.ts');

async function deployment(): Promise<{ url: string; token: string; databasePath: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-deployment-parity-'));
  roots.push(root);
  const databasePath = path.join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0)`).run();
  sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ('mem_machine_1','machine_1',0,NULL)`).run();
  const { token } = await issueMemberToken(sqliteRelationalStore(sqlite), { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
  sqlite.close();
  const started = await serve({ databasePath, blobDir: path.join(root, 'blobs'), port: 0, bind: 'loopback', transport: 'loopback', sourceFrom: 'socket' });
  stops.push(started.stop);
  return { url: `http://127.0.0.1:${started.port}`, token, databasePath };
}

function memberEnv(url: string, token: string, project = 'proj_1'): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-deployment-home-'));
  roots.push(home);
  return { ...env, MYCO_HOME: home, MYCO_NO_AUTO_SPAWN: '1', [ENV_SERVER_URL]: url, [ENV_MEMBER_TOKEN]: token, [ENV_PROJECT]: project };
}

/** An empty working directory: no runtime pin, no vault, nothing of this repository for the spawned process to find. */
function scratchCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-deployment-cwd-'));
  roots.push(cwd);
  return cwd;
}

/** The CLI as a member runs it, spawned without blocking this process: the Deployment it calls is served from here. */
function cli(env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; envelope: any; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'tool', ...args, '--credential', 'env', '--json'], { cwd: scratchCwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const guard = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (status) => {
      clearTimeout(guard);
      let envelope: unknown = null;
      try { envelope = JSON.parse(stdout); } catch { /* the assertion reports the raw output */ }
      resolve({ status, envelope: envelope ?? { raw: stdout }, stderr });
    });
  });
}

const credentials = (databasePath: string): number => {
  const sqlite = new Database(databasePath, { readonly: true });
  try { return (sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as { c: number }).c; } finally { sqlite.close(); }
};

describe('the member tool surface over a real Deployment', () => {
  it('serves the seven tools to the CLI and to an agent through the stdio bridge, answers a call on both, and classifies a refusal for the CLI', async () => {
    const { url, token, databasePath } = await deployment();
    const env = memberEnv(url, token);

    const listed = await cli(env, 'list');
    expect({ status: listed.status, names: listed.envelope.result?.map((t: any) => t.name).sort(), stderr: listed.stderr }).toEqual({ status: 0, names: TOOL_DEFINITIONS.map((d) => d.name).sort(), stderr: listed.stderr });

    const called = await cli(env, 'call', 'myco_plans', '--input', '{"op":"list"}');
    expect(called.envelope).toEqual({ ok: true, tool: 'myco_plans', result: [] });

    const saved = await cli(env, 'call', 'myco_spores', '--input', JSON.stringify({ op: 'save', type: 'gotcha', content: 'over the wire' }));
    expect({ ok: saved.envelope.ok, type: saved.envelope.result?.observation_type }).toEqual({ ok: true, type: 'gotcha' });

    const notServed = await cli(env, 'call', 'myco_search', '--input', '{"query":"q"}');
    expect({ ok: notServed.envelope.ok, code: notServed.envelope.error?.code }).toEqual({ ok: false, code: 'not_served' });

    const refused = await cli(memberEnv(url, token, '..'), 'call', 'myco_plans', '--input', '{}');
    expect({ ok: refused.envelope.ok, code: refused.envelope.error?.code }).toEqual({ ok: false, code: 'no_project' });

    const client = new Client({ name: 'myco-agent-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--credential', 'env'], cwd: scratchCwd(), env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(TOOL_DEFINITIONS.map((d) => d.name).sort());
      const spores = await client.callTool({ name: 'myco_spores', arguments: { op: 'list' } });
      expect((spores.structuredContent as { result: { total: number } }).result.total).toBe(1);
      await expect(client.callTool({ name: 'myco_sessions', arguments: { op: 'purge' } })).rejects.toThrow(/Invalid argument 'op' for tool myco_sessions/);
    } finally {
      await client.close().catch(() => undefined);
    }

    expect(credentials(databasePath)).toBe(1);
  }, 60_000);
});
