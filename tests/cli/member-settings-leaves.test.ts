/**
 * A member never applies a Deployment leaf it is answered (#1541), by behaviour.
 *
 * `POST /members/settings` answers a member every Deployment leaf, and the dashboard marks a leaf retired while
 * nothing reads it. Here every leaf the Deployment holds carries a value of its own that appears nowhere else, and the
 * member's two readers of that answer run against it end to end: `myco config get`, and the sign-in that caches the
 * machine's settings (`myco login`, which runs `seedMachineSettings` and provisions the agents it finds). None of those
 * values may reach the process environment, a global, or any file the member, the agents' configurations or the
 * connected folder hold. The answer is printed by `config get`, and nothing else becomes of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEPLOYMENT_LEAVES } from '@myco-server-worker/core/settings.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { runMemberVerb } from '@myco/cli/member-dispatch.js';
import { run as login } from '@myco/cli/login.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { memberRig, tempMycoHome, unjoinedRig } from '../member/helpers/server.js';
import { registerTestMember } from '../member/helpers/hooks.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';

const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';
/** What every sentinel value carries, and nothing else in these folders or the environment does. */
const MARK = `LEAFSENTINEL${crypto.randomUUID().replace(/-/g, '')}`;

let mycoHome: string;
let checkout: string;
let userHome: string;
const saved = { mycoHome: process.env.MYCO_HOME, home: process.env.HOME };

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-leaves-root-')));
  execFileSync('git', ['init', '-q', checkout]);
  userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-leaves-user-')));
  process.env.HOME = userHome;
});
afterEach(() => {
  if (saved.mycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = saved.mycoHome;
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  resetMachineIdCache();
  for (const dir of [mycoHome, checkout, userHome]) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every Deployment leaf, stored with a value of its own that carries the mark. */
function sentinelLeaves(sqlite: { query: (sql: string) => { run: (...args: unknown[]) => unknown } }): number {
  DEPLOYMENT_LEAVES.forEach((leaf, i) => {
    sqlite.query('INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)')
      .run(leaf, JSON.stringify(leaf === 'agent.tasks' ? { marker: `${MARK}-${i}` } : `${MARK}-${i}`), Date.now(), 'mem_machine_1');
  });
  return DEPLOYMENT_LEAVES.length;
}

/** The files under `dir` that carry the mark, by path. */
function marked(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.readFileSync(full).includes(MARK)) found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return found;
}

/** Where a marked value could have gone that the member keeps: the environment, a global, and the three folders. */
function leaked(globalsBefore: ReadonlySet<string>): Record<string, string[]> {
  const globals = Object.getOwnPropertyNames(globalThis).filter((key) => !globalsBefore.has(key)).filter((key) => {
    try { return JSON.stringify((globalThis as Record<string, unknown>)[key])?.includes(MARK) ?? false; } catch { return false; }
  });
  return {
    env: Object.entries(process.env).filter(([key, value]) => key.includes(MARK) || (value ?? '').includes(MARK)).map(([key]) => key),
    globals,
    mycoHome: marked(mycoHome),
    userHome: marked(userHome),
    checkout: marked(checkout),
  };
}

const NOTHING = { env: [], globals: [], mycoHome: [], userHome: [], checkout: [] };

describe('the Deployment leaves a member is answered', () => {
  it('are printed by myco config get, and nothing else becomes of them', async () => {
    const rig = await memberRig();
    expect(sentinelLeaves(rig.env.sqlite)).toBeGreaterThan(20);
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL, root: checkout });
    const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
    const out: string[] = [];
    const answered = await runMemberVerb('config', ['get'], {
      cwd: checkout, mycoHome, fetch: rig.fetch, stdout: (line) => out.push(line), stderr: () => {},
      worker: { home: userHome, runner: () => ({ status: 1, stdout: '' }) },
    });
    expect(answered).toBe(true);
    // The answer carried every sentinel, and the verb printed them.
    expect(DEPLOYMENT_LEAVES.every((_leaf, i) => out.join('\n').includes(`${MARK}-${i}`))).toBe(true);
    expect(leaked(globalsBefore)).toEqual(NOTHING);
  });

  it('are never applied by a sign-in that caches the machine\'s settings and provisions its agents', async () => {
    const rig = unjoinedRig();
    sentinelLeaves(rig.env.sqlite);
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: PROJECT });
    const platform = recordingPlatform();
    const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
    const ok = await login([`https://s/join#${issued.key}`, '--root', checkout], {
      fetch: rig.fetch as typeof fetch, mycoHome, machineId: 'machine_leaves', stdout: () => {}, stderr: () => {},
      agents: () => ['claude-code', 'codex', 'opencode'],
      worker: {
        home: userHome, platform: 'darwin' as const, binaryPath: path.join(userHome, '.myco', 'bin', 'myco'),
        detect: () => [], harnessDirs: () => [], ownDeploymentUrls: async () => [], admission: async () => 'admitted' as const,
        lockDir: path.join(userHome, 'locks'), runner: platform.runner,
      },
    });
    expect(ok).toBe(true);
    // The sign-in cached this machine's settings and wrote the agents' configurations: there was something to leak into.
    for (const written of ['.claude/settings.json', '.codex/hooks.json', '.config/opencode/plugins/myco.ts']) expect({ written, exists: fs.existsSync(path.join(userHome, written)) }).toEqual({ written, exists: true });
    expect(fs.readdirSync(path.join(mycoHome, 'member', 'deployments')).some((file) => file.endsWith('.machine-settings'))).toBe(true);
    expect(leaked(globalsBefore)).toEqual(NOTHING);
  });
});
