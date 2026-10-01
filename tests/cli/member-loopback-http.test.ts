/**
 * A member of a native Deployment served over plain http on this machine's
 * loopback — the laptop setup `docs/self-hosting.md` documents — captures and
 * reads, whichever way it holds its credential (#1459, #1460).
 *
 * Every process here is the real CLI, spawned the way a harness or a person
 * runs it, against a real self-hosted Deployment at `http://127.0.0.1:<port>`.
 * No fetch is redirected: the URL the member holds is the URL it dials. Every
 * process runs with `HTTP_PROXY` pointing at a capture proxy, which must receive
 * nothing: a loopback dial carrying a bearer never goes through a proxy.
 *
 *   - registry: `myco login http://127.0.0.1:<port>/join#…`, then a hook
 *     declaring `--credential registry`, then `search` and `stats`;
 *   - env triplet: `MYCO_SERVER_URL=http://127.0.0.1:<port>` + token + project;
 *   - env join code: the sandbox settings' `--credential env` with only
 *     `MYCO_JOIN_CODE` set — the first hook redeems it and captures, the second
 *     captures on the same credential, and the reads answer on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken, NO_RUNTIME_CLAIMS } from '@myco-server-worker/auth/tokens.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { callTool } from '@myco/mcp/client-call.js';
import { deploymentTransport, resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { ENV_JOIN_CODE } from '@myco/member/constants.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '@myco/member/credential.js';
import { deploymentPath, registryEntryPath } from '@myco/member/registry.js';
import { tempMycoHome } from '../member/helpers/server.js';

const CLI = path.resolve('packages/myco/src/cli.ts');
const PROJECT = 'proj_1';

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const step of cleanup.reverse()) await step(); });

const tempDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

let loopback: string;
let databasePath: string;
let orchestratorToken: string;
/** A proxy every spawned member process is configured with. A loopback Deployment is dialled directly, so it must see nothing. */
let proxyUrl: string;
const proxied: string[] = [];

/** A Project-bound invitation, as an administrator mints one for a person or a sandbox. */
async function invitation(): Promise<{ id: string; code: string }> {
  const db = new Database(databasePath);
  try {
    const issued = await issueEnrollmentAuthority(sqliteRelationalStore(db), Date.now(), { role: 'member', projectId: PROJECT });
    return { id: issued.id, code: `${loopback}/join#${issued.key}` };
  } finally {
    db.close();
  }
}

function query<T>(sql: string, ...params: string[]): T | null {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.query(sql).get(...params) as T | null;
  } finally {
    db.close();
  }
}

const landed = (sessionId: string): boolean => query('SELECT 1 AS one FROM sessions WHERE session_id = ?', sessionId) !== null;
/** Whether the session lands within `ms`: the hook's kick starts a detached member helper, which delivers it. */
async function landsWithin(sessionId: string, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (landed(sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return landed(sessionId);
}
const spent = (id: string): boolean => query<{ used_at: number | null }>('SELECT used_at FROM enrollment_authorities WHERE id = ?', id)?.used_at != null;

beforeAll(async () => {
  const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { proxied.push(req.url); return new Response(null, { status: 502 }); } });
  cleanup.push(() => { proxy.stop(true); });
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const root = tempDir('myco-loopback-deployment-');
  databasePath = path.join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES (?,?,0)`).run(PROJECT, 'loopback');
  sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ('mem_orchestrated','orchestrated',0,NULL)`).run();
  ({ token: orchestratorToken } = await issueMemberToken(sqliteRelationalStore(sqlite), { memberId: 'mem_orchestrated', machineId: 'machine_orchestrated' }, Date.now(), null, NO_RUNTIME_CLAIMS, { rotates: false }));
  sqlite.close();
  const started = await serve({ databasePath, blobDir: path.join(root, 'blobs'), port: 0, bind: 'loopback', transport: 'loopback', sourceFrom: 'socket' });
  cleanup.push(started.stop);
  loopback = `http://127.0.0.1:${started.port}`;

  // A spore the reads below must find.
  const upstream = resolveDeploymentUpstream('env', { env: { [ENV_SERVER_URL]: loopback, [ENV_MEMBER_TOKEN]: orchestratorToken, [ENV_PROJECT]: PROJECT } })!;
  const saved = await callTool(deploymentTransport(upstream), 'myco_spores', {
    op: 'save', project: PROJECT, type: 'gotcha', content: 'the quokka migration must run before the index rebuild',
  });
  expect(saved.ok).toBe(true);
});

interface Machine { checkout: string; home: string; userHome: string; env: Record<string, string> }

/** A fresh machine: a Git checkout, an empty member home, and the environment its processes carry. */
function machine(env: Record<string, string> = {}): Machine {
  const checkout = tempDir('myco-loopback-checkout-');
  execFileSync('git', ['init', '-q', checkout]);
  const home = tempMycoHome();
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  // Its own machine, so each joins as a member of its own.
  fs.writeFileSync(path.join(home, 'machine_id'), `machine_${path.basename(checkout).replace(/[^A-Za-z0-9]/g, '')}`, 'utf-8');
  return { checkout, home, userHome: tempDir('myco-loopback-user-'), env };
}

function cli(m: Machine, args: string[], stdin?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  for (const key of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_JOIN_CODE, 'NO_PROXY', 'no_proxy']) delete env[key];
  Object.assign(env, { HOME: m.userHome, MYCO_HOME: m.home, MYCO_NO_AUTO_SPAWN: '1', HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl }, m.env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: m.checkout, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    if (stdin !== undefined) child.stdin!.end(stdin);
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => { clearTimeout(guard); resolve({ status, stdout, stderr }); });
  });
}

/** A Claude Code Stop told to ship inline, as a sandbox's turn end runs: it delivers what the session captured. */
function inlineStop(m: Machine, sessionId: string) {
  const input = { session_id: sessionId, cwd: m.checkout, hook_event_name: 'Stop', last_assistant_message: 'done' };
  return cli(m, ['hook', 'stop', '--symbiont', 'claude-code', '--credential', 'env', '--ship', 'inline'], JSON.stringify(input));
}

/** A Claude Code SessionStart, as the harness hands it to the hook command on stdin. */
function sessionStart(m: Machine, sessionId: string, source: 'registry' | 'env') {
  const transcript = path.join(tempDir('myco-loopback-tx-'), `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }] } })}\n`);
  const input = { session_id: sessionId, transcript_path: transcript, cwd: m.checkout, hook_event_name: 'SessionStart', source: 'startup' };
  return cli(m, ['hook', 'session-start', '--symbiont', 'claude-code', '--credential', source], JSON.stringify(input));
}

/** `search` and `stats` answered by the loopback Deployment, as the declared source reads it. */
async function expectReads(m: Machine, source: 'registry' | 'env' | null): Promise<void> {
  const flag = source === null ? [] : ['--credential', source];
  const search = await cli(m, ['search', 'quokka', ...flag]);
  expect({ status: search.status, stderr: search.stderr }).toEqual({ status: 0, stderr: '' });
  expect(search.stdout).toContain(`Deployment: ${loopback}  project: ${PROJECT}`);
  expect(search.stdout).toContain('[spore] the quokka migration must run before the index rebuild');
  const stats = await cli(m, ['stats', ...flag]);
  expect({ status: stats.status, stderr: stats.stderr }).toEqual({ status: 0, stderr: '' });
  expect(stats.stdout).toContain(`Project:    ${PROJECT} (loopback)`);
}

describe('a member of a loopback http native Deployment', () => {
  afterAll(() => {
    // Every process above ran with HTTP_PROXY set; not one request, bearer or join code reached it.
    expect(proxied).toEqual([]);
  });

  it('registry: joins with `myco login`, captures a session, and answers search and stats', async () => {
    const m = machine();
    const invite = await invitation();
    const login = await cli(m, ['login', invite.code]);
    expect(login.status).toBe(0);
    expect(spent(invite.id)).toBe(true);

    const hook = await sessionStart(m, 'sess-loopback-registry', 'registry');
    expect(hook.stderr).not.toContain('no capture');
    expect(await landsWithin('sess-loopback-registry')).toBe(true);
    await expectReads(m, null);
    await expectReads(m, 'registry');

    // A renewal dials the entry's URL straight from the registry, before any admission: the process-wide bypass carries it.
    for (const file of [registryEntryPath(m.checkout, m.home), deploymentPath(loopback, m.home)]) {
      if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), refreshAfter: 1 }));
    }
    const refresh = await cli(m, ['member', 'refresh']);
    expect(refresh.status).toBe(0);
    // The Deployment's own answer: it holds the window, so this dial reached it.
    expect(refresh.stdout).toContain(`${PROJECT}: the server is not ready to rotate yet`);
  }, 90_000);

  it('env triplet: captures a session and answers search and stats', async () => {
    const m = machine({ [ENV_SERVER_URL]: loopback, [ENV_MEMBER_TOKEN]: orchestratorToken, [ENV_PROJECT]: PROJECT });
    const hook = await sessionStart(m, 'sess-loopback-env', 'env');
    expect(hook.stderr).not.toContain('no capture');
    // A credential from the environment delivers at the turn's end, in the hook.
    expect((await inlineStop(m, 'sess-loopback-env')).status).toBe(0);
    expect(landed('sess-loopback-env')).toBe(true);
    await expectReads(m, 'env');
  }, 90_000);

  it('env join code: the first hook redeems the code and captures, the second captures on the same credential, and the reads answer', async () => {
    const invite = await invitation();
    const m = machine({ [ENV_JOIN_CODE]: invite.code });
    const first = await sessionStart(m, 'sess-loopback-code-1', 'env');
    expect(first.stderr).not.toContain('no capture');
    expect(spent(invite.id)).toBe(true);
    // A sandbox delivers at the turn's end, in the hook: no helper it started would outlive it.
    expect((await inlineStop(m, 'sess-loopback-code-1')).status).toBe(0);
    expect(landed('sess-loopback-code-1')).toBe(true);

    const second = await sessionStart(m, 'sess-loopback-code-2', 'env');
    expect(second.stderr).not.toContain('no capture');
    expect((await inlineStop(m, 'sess-loopback-code-2')).status).toBe(0);
    expect(landed('sess-loopback-code-2')).toBe(true);
    const tokens = query<{ n: number }>(
      `SELECT count(DISTINCT created_by_token_id) AS n FROM sessions WHERE session_id IN ('sess-loopback-code-1','sess-loopback-code-2')`,
    );
    expect(tokens?.n).toBe(1);
    await expectReads(m, 'env');
  }, 90_000);

  it('plain http to a host off this machine is refused everywhere a member takes a server URL', async () => {
    const m = machine({ [ENV_SERVER_URL]: 'http://10.0.0.5:8787', [ENV_MEMBER_TOKEN]: orchestratorToken, [ENV_PROJECT]: PROJECT });
    const hook = await sessionStart(m, 'sess-offbox-env', 'env');
    expect(hook.stderr).toContain("MYCO_SERVER_URL must be https, or http on this machine's loopback — no capture");
    expect(landed('sess-offbox-env')).toBe(false);

    const login = await cli(machine(), ['login', `http://10.0.0.5:8787/join#${'k'.repeat(43)}`]);
    expect(login.status).not.toBe(0);
    expect(login.stderr).toContain("a join link must be https, or http on this machine's loopback");

    const join = await cli(machine({ JOIN_TOKEN: orchestratorToken }), ['member', 'join', 'http://10.0.0.5:8787', '--project', PROJECT, '--token-env', 'JOIN_TOKEN']);
    expect(join.status).toBe(2);
    expect(join.stderr).toContain("is not a server URL a member accepts (https, or http on this machine's loopback)");
  }, 90_000);
});
