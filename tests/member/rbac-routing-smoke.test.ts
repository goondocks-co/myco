import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parse as parseToml } from 'smol-toml';
import { issueMemberToken, NO_RUNTIME_CLAIMS } from '@myco-server-worker/auth/tokens.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { callTool } from '@myco/mcp/client-call.js';
import { readRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';

const PROJECT = 'proj_routing_same';
const SESSION = 'sess_routing_same';
const BINARY = process.env.MYCO_RBAC_SMOKE_BINARY
  ?? path.resolve(`packages/myco-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'myco.exe' : 'myco'}`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rbac-routing-'));
const userHome = path.join(scratch, 'home');
const mycoHome = path.join(scratch, 'myco-home');
const codeHome = path.join(scratch, 'codex');
const claudeHome = path.join(scratch, 'claude');
const tmp = path.join(scratch, 'tmp');
const managedBinary = path.join(mycoHome, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco');
const stops: Array<() => Promise<void> | void> = [];

interface Deployment { url: string; database: string; blobDir: string; token: string }
const deployments: Deployment[] = [];
const roots = [path.join(scratch, 'repo-a'), path.join(scratch, 'repo-b')];

function querySession(database: string): number {
  const db = new Database(database, { readonly: true });
  try { return (db.query('SELECT count(*) AS n FROM sessions WHERE session_id = ?').get(SESSION) as { n: number }).n; }
  finally { db.close(); }
}

async function createDeployment(index: number): Promise<Deployment> {
  const dir = path.join(scratch, `deployment-${index}`);
  fs.mkdirSync(dir, { recursive: true });
  const database = path.join(dir, 'myco.sqlite');
  const sqlite = new Database(database);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 0)').run(PROJECT, `route-${index}`);
  sqlite.query('INSERT INTO members (id, label, created_at, revoked_at) VALUES (?, ?, 0, NULL)').run(`mem_route_${index}`, `route-${index}`);
  const { token } = await issueMemberToken(sqliteRelationalStore(sqlite),
    { memberId: `mem_route_${index}`, machineId: 'machine_routing_same' }, Date.now(), null, NO_RUNTIME_CLAIMS, { rotates: false });
  sqlite.close();

  const blobDir = path.join(dir, 'blobs');
  const native = await serve({ databasePath: database, blobDir, port: 0,
    bind: 'loopback', transport: 'loopback', sourceFrom: 'socket' });
  stops.push(native.stop);
  return { url: `http://127.0.0.1:${native.port}`, database, blobDir, token };
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, MYCO_HOME: mycoHome, CODEX_HOME: codeHome,
    CLAUDE_CONFIG_DIR: claudeHome, TMPDIR: tmp, TMP: tmp, TEMP: tmp, MYCO_NO_AUTO_SPAWN: '1', NO_COLOR: '1' };
  for (const key of ['MYCO_SERVER_URL', 'MYCO_MEMBER_TOKEN', 'MYCO_PROJECT', 'MYCO_JOIN_CODE',
    'MYCO_CLAIMS_HOME', 'MYCO_TEST_REAL_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[key];
  env.NO_PROXY = '127.0.0.1,localhost';
  return env;
}

function cli(root: string, args: string[], input?: string, executable = BINARY): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, { cwd: root, env: childEnv(), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout!.on('data', (data) => { out += String(data); });
    proc.stderr!.on('data', (data) => { err += String(data); });
    proc.on('error', reject);
    if (input !== undefined) proc.stdin!.end(input);
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.on('close', (code) => { clearTimeout(timeout); resolve({ code, out, err }); });
  });
}

beforeAll(async () => {
  if (!fs.existsSync(BINARY)) {
    if (process.env.CI) throw new Error('RBAC routing smoke requires the built binary in CI');
    return;
  }
  for (const dir of [userHome, mycoHome, codeHome, claudeHome, tmp, ...roots]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.dirname(managedBinary), { recursive: true });
  fs.copyFileSync(BINARY, managedBinary);
  fs.chmodSync(managedBinary, 0o755);
  fs.writeFileSync(path.join(mycoHome, 'machine_id'), 'machine_routing_same');
  for (const root of roots) execFileSync('git', ['init', '-q', root], { env: childEnv() });
  deployments.push(await createDeployment(0), await createDeployment(1));
  for (const deployment of deployments) expect((await fetch(`${deployment.url}/health`)).status).toBe(200);
});

afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

it.skipIf(!fs.existsSync(BINARY) && !process.env.CI)('routes one machine and identical Project/session IDs to the repositories\' explicit Deployments', async () => {
  for (const [index, root] of roots.entries()) {
    const deployment = deployments[index];
    const joined = await cli(root, ['member', 'join', deployment.url, '--project', PROJECT, '--token-stdin', '--no-worker'], `${deployment.token}\n`);
    expect(joined.code, joined.err).toBe(0);
    expect(readRegistryEntry(root, mycoHome)?.serverUrl).toBe(deployment.url);
    const codex = loadManifests().find((manifest) => manifest.name === 'codex')!;
    expect(new SymbiontInstaller(codex, root, resolvePackageRoot(), false, undefined, null, 'member-project', mycoHome).installMemberMcp()).toBe(true);
  }

  for (const [index, root] of roots.entries()) {
    const deployment = deployments[index];
    const installed = parseToml(fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { myco: { url: string; http_headers_helper: string } };
    };
    const entry = installed.mcp_servers.myco;
    expect(entry.url).toBe(`${deployment.url}/mcp`);
    const [binary, ...args] = entry.http_headers_helper.split(' ');
    expect(binary).toBe(managedBinary);
    const helper = await cli(root, args, undefined, binary);
    expect(helper.code, helper.err).toBe(0);
    const headers = JSON.parse(helper.out) as Record<string, string>;
    expect(headers['x-myco-project']).toBe(PROJECT);
    const transport = () => new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } });
    const saved = await callTool(transport(), 'myco_spores', {
      op: 'save', project: PROJECT, type: 'gotcha', content: `routing marker ${index} for the same project`,
    });
    expect(saved.ok).toBe(true);
    const search = await cli(root, ['search', `routing marker ${index}`, '--credential', 'registry']);
    expect(search.code).toBe(0);
    expect(search.out).toContain(`routing marker ${index}`);
    expect(search.out).not.toContain(`routing marker ${1 - index}`);
  }

  for (const [index, root] of roots.entries()) {
    const transcript = path.join(root, `${SESSION}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: `routing capture marker ${index}` }] } })}\n`);
    const started = await cli(root, ['hook', 'session-start', '--symbiont', 'claude-code', '--credential', 'registry'],
      JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: root, hook_event_name: 'SessionStart', source: 'startup' }));
    expect(started.err).not.toContain('no capture');
    const ended = await cli(root, ['hook', 'stop', '--symbiont', 'claude-code', '--credential', 'registry', '--ship', 'inline'],
      JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: root, hook_event_name: 'Stop', last_assistant_message: 'done' }));
    expect(ended.code).toBe(0);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && deployments.some((deployment) => querySession(deployment.database) !== 1))
    await Bun.sleep(100);
  expect(deployments.map((deployment) => querySession(deployment.database))).toEqual([1, 1]);
  const storedText = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? storedText(file) : fs.readFileSync(file, 'utf8');
  }).join('\n');
  for (const [index, deployment] of deployments.entries()) {
    const text = storedText(deployment.blobDir);
    expect(text).toContain(`routing capture marker ${index}`);
    expect(text).not.toContain(`routing capture marker ${1 - index}`);
  }
}, 120_000);
