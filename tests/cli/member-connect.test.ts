/**
 * `myco member join`, run inside a repository, connects it to a project on the member's Deployment (#1499).
 *
 * No token is typed: the membership `myco login` recorded carries it. The project is one the Deployment holds, named
 * by id or name, or one created for the folder, and the dashboard's project list shows it at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordingPlatform } from '../member/helpers/service-platform.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { run as login } from '@myco/cli/login.js';
import { runJoin } from '@myco/cli/member.js';
import { readRegistryEntry } from '@myco/member/registry.js';
import { unjoinedRig } from '../member/helpers/server.js';

describe('myco member join inside a repository', () => {
  let home: string;
  let repos: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-connect-home-'));
    repos = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-connect-repos-'));
    out = [];
    err = [];
    process.exitCode = 0;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repos, { recursive: true, force: true });
    process.exitCode = 0;
  });

  const repo = (name: string): string => {
    const dir = path.join(repos, name);
    fs.mkdirSync(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    return dir;
  };
  /** A machine signed in with an invite that names no project, and no agent to set up. */
  const signedIn = async () => {
    const rig = unjoinedRig();
    const key = (await issueEnrollmentAuthority(rig.env.db, Date.now(), { issuer: { kind: 'operator' }, role: 'member' })).key;
    expect(await login([`https://s/join#${key}`, '--no-agents'], { fetch: rig.fetch as typeof fetch, mycoHome: home, machineId: 'machine_person', cwd: repos, stdout: () => {}, stderr: () => {}, worker: { home, runner: recordingPlatform().runner } })).toBe(true);
    return rig;
  };
  const deps = (rig: ReturnType<typeof unjoinedRig>, cwd: string, extra: Record<string, unknown> = {}) => ({
    fetch: rig.fetch as typeof fetch, mycoHome: home, cwd, agents: () => [], stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), worker: { home, runner: recordingPlatform().runner }, ...extra,
  });
  const projects = (rig: ReturnType<typeof unjoinedRig>) => rig.env.sqlite.query('SELECT project_id, name FROM projects ORDER BY created_at, project_id').all() as { project_id: string; name: string }[];

  it('creates a project named for the folder with --new, connects the folder to it, and the Deployment lists it at once', async () => {
    const rig = await signedIn();
    const dir = repo('billing-service');
    const entry = await runJoin(['--new'], deps(rig, dir));
    expect(entry).not.toBeNull();
    const created = projects(rig).find((p) => p.name === 'billing-service');
    expect(created?.project_id).toMatch(/^proj_[0-9a-f]{32}$/);
    expect(readRegistryEntry(dir, home)).toMatchObject({ projectId: created!.project_id, serverUrl: 'https://s' });
    expect(out.join('\n')).toContain(`Connected ${dir} to project billing-service (${created!.project_id})`);
    expect(err).toEqual([]);
  });

  it.each(['--new', 'interactive'])('names a new Project for the main checkout from a linked worktree (%s)', async (mode) => {
    const rig = await signedIn();
    const main = repo('whisker-sites');
    const linked = path.join(repos, 'w9-task-5-terraform-alerts');
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: main });
    execFileSync('git', ['worktree', 'add', '-qb', 'worker', linked], { cwd: main, stdio: 'pipe' });
    const entry = await runJoin(mode === '--new' ? ['--new', '--no-worker'] : ['--no-worker'], deps(rig, linked, { ask: async () => 'n' }));
    expect(entry).not.toBeNull();
    expect(projects(rig).find((p) => p.project_id === entry!.projectId)?.name).toBe('whisker-sites');
  });

  it('reads a server URL after --new as the Deployment, and names the project for the folder', async () => {
    const rig = await signedIn();
    const dir = repo('ledger');
    expect((await runJoin(['--new', 'https://s'], deps(rig, dir)))?.serverUrl).toBe('https://s');
    const before = ['a', 'b'];
    expect(projects(rig).map((p) => p.name).filter((name) => !before.includes(name))).toEqual(['ledger']);
    expect(readRegistryEntry(dir, home)?.projectId).toBe(projects(rig).find((p) => p.name === 'ledger')!.project_id);
  });

  it('connects a second repository to an existing project by name or by id, with no token typed', async () => {
    const rig = await signedIn();
    await runJoin(['--new', 'Shared work'], deps(rig, repo('one')));
    const shared = projects(rig).find((p) => p.name === 'Shared work')!;
    const byName = repo('two');
    expect((await runJoin(['--project', 'shared WORK'], deps(rig, byName)))?.projectId).toBe(shared.project_id);
    const byId = repo('three');
    expect((await runJoin(['--project', shared.project_id], deps(rig, byId)))?.projectId).toBe(shared.project_id);
    expect(projects(rig).filter((p) => p.name === 'Shared work')).toHaveLength(1);
  });

  it('asks a terminal which project, lists them where none can answer, and connects nothing on an answer that names none', async () => {
    const rig = await signedIn();
    await runJoin(['--new', 'Existing'], deps(rig, repo('first')));
    const dir = repo('second');
    // No terminal: the projects and both commands are listed, and nothing is written.
    expect(await runJoin([], deps(rig, dir, { ask: async () => null }))).toBeNull();
    expect(out.join('\n')).toContain('1) Existing');
    expect(err.join('\n')).toContain('myco member join --project <id or name>');
    expect(readRegistryEntry(dir, home)).toBeNull();
    // A terminal picks the first, or a new one named for the folder.
    const asked: string[] = [];
    expect((await runJoin([], deps(rig, dir, { ask: async (q: string) => { asked.push(q); return '1'; } })))?.projectId).toBe(projects(rig).find((p) => p.name === 'Existing')!.project_id);
    expect(asked[0]).toContain('n) a new project named "second"');
    const third = repo('third');
    expect((await runJoin([], deps(rig, third, { ask: async () => 'n' })))?.projectId).toBe(projects(rig).find((p) => p.name === 'third')!.project_id);
    const fourth = repo('fourth');
    expect(await runJoin([], deps(rig, fourth, { ask: async () => '9' }))).toBeNull();
    expect(readRegistryEntry(fourth, home)).toBeNull();
  });

  it('refuses outside a repository and on a machine not signed in, naming what to do', async () => {
    const rig = unjoinedRig();
    expect(await runJoin(['--new'], deps(rig, repo('lonely')))).toBeNull();
    expect(err.join('\n')).toContain('run `myco login <invite link>` first');
  });
});
