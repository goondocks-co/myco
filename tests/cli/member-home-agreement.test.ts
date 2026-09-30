/**
 * Every member verb uses the one home a folder resolves to (#1499).
 *
 * A sandbox where a `.myco/runtime.home` pin above the repository names another home: `myco login` and `myco member
 * join` in that repository either both use the pinned home, saying so, or refuse and name the fix. Neither ever reads
 * the credential of a home the person did not name, nor falls back to this machine's own home.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { run as login } from '@myco/cli/login.js';
import { runJoin } from '@myco/cli/member.js';
import { listDeploymentMemberships, readRegistryEntry, writeDeploymentMembership } from '@myco/member/registry.js';
import { unjoinedRig } from '../member/helpers/server.js';

describe('the home a pinned repository uses', () => {
  let base: string;
  let userHome: string;
  let repo: string;
  let pinnedHome: string;
  let pinPath: string;
  let out: string[];
  let err: string[];
  const saved = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-agreement-')));
    userHome = path.join(base, 'user');
    pinnedHome = path.join(base, 'elsewhere', 'home');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(pinnedHome, { recursive: true });
    // A pin above the repository, the way an account's own ~/.myco/runtime.home sits above every repository in it.
    const pinnedTree = path.join(base, 'pinned');
    pinPath = path.join(pinnedTree, '.myco', 'runtime.home');
    fs.mkdirSync(path.dirname(pinPath), { recursive: true });
    fs.writeFileSync(pinPath, `${pinnedHome}\n`, { mode: 0o600 });
    repo = path.join(pinnedTree, 'code', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    process.env.HOME = userHome;
    delete process.env.MYCO_HOME;
    out = [];
    err = [];
    process.exitCode = 0;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
    process.exitCode = 0;
  });

  /** A fetch that serves the rig's Deployment and records every other host it was asked for. */
  const serving = (rig: ReturnType<typeof unjoinedRig>, elsewhere: string[]) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://s') { elsewhere.push(url.origin); return new Response(null, { status: 599 }); }
    return (rig.fetch as typeof fetch)(input, init);
  }) as typeof fetch;
  const invite = async (rig: ReturnType<typeof unjoinedRig>) => `https://s/join#${(await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member' })).key}`;
  const io = { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };

  it('signs in and connects in the pinned home, saying which and why, and never uses this machine\'s own home', async () => {
    const rig = unjoinedRig();
    const elsewhere: string[] = [];
    const fetch = serving(rig, elsewhere);
    expect(await login([await invite(rig), '--no-agents'], { fetch, machineId: 'machine_person', cwd: repo, ...io })).toBe(true);
    expect(out.join('\n')).toContain(`Using ${pinnedHome}: ${repo} is pinned to it by ${pinPath}.`);
    expect(listDeploymentMemberships(pinnedHome).map((m) => m.serverUrl)).toEqual(['https://s']);
    expect(fs.existsSync(path.join(userHome, '.myco', 'member'))).toBe(false);
    // The pin sends the repository away from this machine's own home, so the Deployment is named; the same home answers.
    expect(await runJoin(['--new', '--no-agents'], { fetch, cwd: repo, ...io })).toBeNull();
    expect(err.join('\n')).toContain(`${repo} is pinned to ${pinnedHome} by ${pinPath}`);
    err = [];
    expect((await runJoin(['https://s', '--new', '--no-agents'], { fetch, cwd: repo, agents: () => [], ...io }))?.serverUrl).toBe('https://s');
    expect(readRegistryEntry(repo, pinnedHome)?.serverUrl).toBe('https://s');
    expect(fs.existsSync(path.join(userHome, '.myco', 'member'))).toBe(false);
    expect(elsewhere).toEqual([]);
  });

  it('refuses to connect where the pinned home holds another Deployment\'s membership and none was named, reading no credential', async () => {
    // Signed in from a folder with no pin: this machine's own home.
    const rig = unjoinedRig();
    const elsewhere: string[] = [];
    const fetch = serving(rig, elsewhere);
    const free = path.join(base, 'free');
    fs.mkdirSync(free);
    expect(await login([await invite(rig), '--no-agents'], { fetch, machineId: 'machine_person', cwd: free, ...io })).toBe(true);
    expect(listDeploymentMemberships(path.join(userHome, '.myco')).map((m) => m.serverUrl)).toEqual(['https://s']);
    // The pinned home belongs to another installation, signed in to another Deployment.
    writeDeploymentMembership({ serverUrl: 'https://other.example', token: 'B'.repeat(43), machineId: 'm_other', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: pinnedHome });
    out = [];
    expect(await runJoin(['--new', '--no-agents'], { fetch, cwd: repo, ...io })).toBeNull();
    expect(err.join('\n')).toContain(`${repo} is pinned to ${pinnedHome} by ${pinPath}, which holds a membership of https://other.example`);
    expect(elsewhere).toEqual([]);
    expect(readRegistryEntry(repo, pinnedHome)).toBeNull();
    expect(readRegistryEntry(repo, path.join(userHome, '.myco'))).toBeNull();
  });

  it('refuses where the pinned home holds no membership, naming the pin and the fix, and never falls back to this machine\'s home', async () => {
    const rig = unjoinedRig();
    const elsewhere: string[] = [];
    const fetch = serving(rig, elsewhere);
    const free = path.join(base, 'free');
    fs.mkdirSync(free);
    expect(await login([await invite(rig), '--no-agents'], { fetch, machineId: 'machine_person', cwd: free, ...io })).toBe(true);
    for (const args of [['--new', '--no-agents'], ['https://s', '--new', '--no-agents']]) {
      err = [];
      expect(await runJoin(args, { fetch, cwd: repo, ...io })).toBeNull();
      expect(err.join('\n')).toContain(`${repo} is pinned to ${pinnedHome} by ${pinPath}, which holds no membership`);
      expect(err.join('\n')).toContain('Sign in there with `myco login <invite link>` from this folder, or remove the pin');
    }
    expect(readRegistryEntry(repo, path.join(userHome, '.myco'))).toBeNull();
    expect(elsewhere).toEqual([]);
  });
});
