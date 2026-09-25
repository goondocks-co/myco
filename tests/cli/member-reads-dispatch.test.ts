/**
 * The dispatched CLI in a fresh joined checkout: `myco search|session|stats`
 * spawned as a member runs them, in a Git checkout with no `.myco/` and no
 * `myco.yaml`, under a home whose registry holds the checkout's membership of a
 * real self-hosted Deployment on this machine's loopback. The answers are the
 * Deployment's, and the run leaves no vault, Grove, daemon state or database.
 *
 * A registry membership names an `https:` Deployment, so the spawned process
 * carries a preload that sends that origin's requests to the loopback server
 * (`tests/helpers/redirect-fetch-preload.ts`); the command line, the registry
 * and the dispatcher are a member's.
 *
 * `doctor`, `config get`, `logs` and `--help` run as the member there too. A
 * checkout with no membership still takes the verb's 1.4 handler, which
 * refuses without a vault and creates none, and prints the 1.4 command list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { callTool } from '@myco/mcp/client-call.js';
import { deploymentTransport, resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '@myco/member/credential.js';
import { registryEntryPath } from '@myco/member/registry.js';
import { unmemberedDir } from '@myco/member/no-membership.js';
import { registerTestMember } from '../member/helpers/hooks.js';
import { tempMycoHome } from '../member/helpers/server.js';

const CLI = path.resolve('packages/myco/src/cli.ts');
const PRELOAD = path.resolve('tests/helpers/redirect-fetch-preload.ts');
const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const step of cleanup.reverse()) await step(); });

const tempDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

let loopback: string;
let token: string;

beforeAll(async () => {
  const root = tempDir('myco-reads-deployment-');
  const databasePath = path.join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES (?,?,0)`).run(PROJECT, 'reads');
  // A second, newer Project leads the Deployment's project list; stats must still report the joined one.
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_2','other',1)`).run();
  sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ('mem_machine_1','machine_1',0,NULL)`).run();
  sqlite.query(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('instructions.template',?,0,'mem_machine_1')`).run(JSON.stringify('Answer from the Deployment.'));
  ({ token } = await issueMemberToken(sqliteRelationalStore(sqlite), { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now()));
  sqlite.close();
  const started = await serve({ databasePath, blobDir: path.join(root, 'blobs'), port: 0, bind: 'loopback', transport: 'loopback', sourceFrom: 'socket' });
  cleanup.push(started.stop);
  loopback = `http://127.0.0.1:${started.port}`;

  // A spore saved through the served tool an agent calls.
  const upstream = resolveDeploymentUpstream('env', { env: { [ENV_SERVER_URL]: loopback, [ENV_MEMBER_TOKEN]: token, [ENV_PROJECT]: PROJECT } })!;
  const saved = await callTool(deploymentTransport(upstream), 'myco_spores', {
    op: 'save', project: PROJECT, type: 'gotcha', content: 'the quokka migration must run before the index rebuild',
  });
  expect(saved.ok).toBe(true);
});

interface Machine { checkout: string; home: string; userHome: string; cwd?: string }

/** A fresh checkout and member home; joined to the Deployment when asked. */
function machine(joined: boolean): Machine {
  const checkout = tempDir('myco-reads-checkout-');
  execFileSync('git', ['init', '-q', checkout]);
  const home = tempMycoHome();
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  if (joined) registerTestMember({ mycoHome: home, token, projectId: PROJECT, serverUrl: SERVER_URL, root: checkout });
  return { checkout, home, userHome: tempDir('myco-reads-user-') };
}

function cli(m: Machine, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  Object.assign(env, {
    HOME: m.userHome, MYCO_HOME: m.home, MYCO_NO_AUTO_SPAWN: '1',
    MYCO_TEST_FETCH_FROM: SERVER_URL, MYCO_TEST_FETCH_TO: loopback,
  });
  for (const key of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT]) delete env[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--preload', PRELOAD, CLI, ...args], { cwd: m.cwd ?? m.checkout, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => { clearTimeout(guard); resolve({ status, stdout, stderr }); });
  });
}

/** What a 1.4 install leaves: a project vault, a Grove, daemon state, a SQLite file. */
function legacyArtifacts(m: Machine): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (['.myco', 'groves', 'daemon.json', 'daemon.lock', 'service', 'myco.yaml'].includes(entry.name)) found.push(full);
      else if (/\.(db|sqlite)(-wal|-shm)?$/.test(entry.name)) found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  for (const dir of [m.checkout, m.home, m.userHome]) walk(dir);
  return found;
}

describe('the dispatched read verbs in a fresh joined checkout', () => {
  it('search answers from the Deployment', async () => {
    const m = machine(true);
    const ran = await cli(m, 'search', 'quokka');
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain(`Deployment: ${SERVER_URL}  project: ${PROJECT}`);
    expect(ran.stdout).toContain('[spore] the quokka migration must run before the index rebuild');
    expect(legacyArtifacts(m)).toEqual([]);
  }, 40_000);

  it('session latest and stats answer from the Deployment', async () => {
    const m = machine(true);
    const session = await cli(m, 'session', 'latest');
    expect(session.status).toBe(0);
    expect(session.stdout).toContain(`Deployment: ${SERVER_URL}  project: ${PROJECT}`);
    expect(session.stdout).toContain('No sessions found');
    const stats = await cli(m, 'stats');
    expect(stats.status).toBe(0);
    expect(stats.stdout).toContain(`Project:    ${PROJECT} (reads)`);
    expect(stats.stdout).toContain('Sessions:      0');
    expect(legacyArtifacts(m)).toEqual([]);
  }, 40_000);

  it('doctor, config get, logs and --help run as the member', async () => {
    const m = machine(true);
    const doctor = await cli(m, 'doctor');
    expect(doctor.stdout).toContain('myco doctor (member)');
    expect(doctor.stdout).toMatch(/Deployment\s+.*ok.*answers, and serves this machine's credential \d+ tools/);
    expect(doctor.stdout).not.toMatch(/Vault|Database|Daemon|Grove/);
    const config = await cli(m, 'config', 'get', 'instructions.template');
    expect({ status: config.status, stdout: config.stdout.trim(), stderr: config.stderr }).toEqual({ status: 0, stdout: 'Answer from the Deployment.', stderr: '' });
    const logs = await cli(m, 'logs');
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain('=== refused events (proj_1) ===');
    const help = await cli(m, '--help');
    expect(help.stdout).toContain('Project intelligence (answered by the Deployment for this project)');
    expect(help.stdout).not.toMatch(/grove|daemon|stdio/i);
    expect(legacyArtifacts(m)).toEqual([]);
  }, 60_000);
  it('a subdirectory of the joined root, and a worktree of the joined repository, reach the same Deployment', async () => {
    const m = machine(true);
    const sub = path.join(m.checkout, 'packages', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const fromSub = await cli({ ...m, cwd: sub }, 'search', 'quokka');
    expect(fromSub.stderr).toBe('');
    expect(fromSub.stdout).toContain(`Deployment: ${SERVER_URL}  project: ${PROJECT}`);

    execFileSync('git', ['-C', m.checkout, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']);
    const worktree = path.join(tempDir('myco-reads-worktrees-'), 'wt');
    execFileSync('git', ['-C', m.checkout, 'worktree', 'add', '-q', worktree]);
    const fromWorktree = await cli({ ...m, cwd: worktree }, 'search', 'quokka');
    expect(fromWorktree.stderr).toBe('');
    expect(fromWorktree.stdout).toContain(`Deployment: ${SERVER_URL}  project: ${PROJECT}`);
    expect(legacyArtifacts(m)).toEqual([]);
  }, 40_000);

  it('a membership whose entry cannot be read is refused by name, never answered by the 1.4 handler, and records no missed capture', async () => {
    const m = machine(true);
    const entry = registryEntryPath(m.checkout, m.home);
    fs.writeFileSync(entry, '{ not json');
    const ran = await cli(m, 'search', 'quokka');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(`this project's membership could not be read: ${entry}`);
    expect(ran.stderr).not.toContain('No myco.yaml found');
    expect(ran.stderr).not.toContain('no registry entry');
    expect(fs.existsSync(unmemberedDir(m.home))).toBe(false);
    expect(legacyArtifacts(m)).toEqual([]);
  }, 40_000);

  it('a declared registry credential in a directory with no membership is refused, and records no missed capture', async () => {
    const m = machine(false);
    const ran = await cli(m, 'stats', '--credential', 'registry');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(`${m.checkout} holds no membership under ${m.home}`);
    expect(fs.existsSync(unmemberedDir(m.home))).toBe(false);
    expect(legacyArtifacts(m)).toEqual([]);
  }, 40_000);

  it('a checkout with no membership takes the local handler, which refuses without a vault and creates none', async () => {
    const m = machine(false);
    const ran = await cli(m, 'search', 'quokka');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('No myco.yaml found');
    const fresh = await cli(m, '--help');
    expect(fresh.stdout).toContain('Project intelligence (answered by the Deployment for this project)');
    fs.mkdirSync(path.join(m.home, 'groves'));
    const legacy = await cli(m, '--help');
    expect(legacy.stdout).toContain('grove <subcommand>');
    expect(legacy.stdout).not.toContain('2.0 member (a project joined');
    expect(legacyArtifacts(m).filter((p) => p !== path.join(m.home, 'groves'))).toEqual([]);
  }, 40_000);
});
