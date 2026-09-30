/**
 * `myco login` sets up the agents installed on this machine (#1499).
 *
 * A person who follows "install, then login" captures from their first session: every agent the machine has is
 * provisioned for the Deployment, through the cutover's own detection and ownership preview. An agent whose entries
 * belong to another installation is left byte for byte as it is and named.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { run } from '@myco/cli/login.js';
import { runProvision } from '@myco/cli/member.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { unjoinedRig } from '../member/helpers/server.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';

describe('myco login sets up the agents on this machine', () => {
  let home: string;
  let root: string;
  let out: string[];
  let err: string[];
  const userHome = os.homedir();
  const claudeDir = path.join(userHome, '.claude');
  const codexDir = path.join(userHome, '.codex');
  const agentFiles = [claudeDir, codexDir, path.join(userHome, '.claude.json')];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-agents-home-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-agents-root-'));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    for (const file of agentFiles) fs.rmSync(file, { recursive: true, force: true });
    out = [];
    err = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    for (const file of agentFiles) fs.rmSync(file, { recursive: true, force: true });
  });

  const platform = recordingPlatform();
  const deps = (rig: ReturnType<typeof unjoinedRig>, extra: Record<string, unknown> = {}) => ({
    fetch: rig.fetch as typeof fetch, mycoHome: home, machineId: 'machine_person', cwd: root,
    stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l),
    worker: {
      home, platform: 'darwin' as const, binaryPath: path.join(home, 'bin', 'myco'), detect: () => [], harnessDirs: () => [],
      ownDeploymentUrls: async () => [], admission: async () => 'admitted' as const, lockDir: path.join(home, 'locks'), runner: platform.runner,
    },
    ...extra,
  });
  const invite = async (rig: ReturnType<typeof unjoinedRig>, projectId?: string) =>
    `https://s/join#${(await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', ...(projectId === undefined ? {} : { projectId }) })).key}`;
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  it('provisions every agent it detects for the Deployment, with no project connected yet, and says so', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig))).toBe(true);
    const hooks = read(path.join(claudeDir, 'settings.json')) ?? '';
    expect(hooks).toContain('--credential registry');
    expect(read(path.join(userHome, '.claude.json')) ?? '').toContain('https://s');
    expect(read(path.join(codexDir, 'hooks.json')) ?? '').toContain('--credential registry');
    expect(read(path.join(codexDir, 'config.toml')) ?? '').toContain('https://s');
    expect(out.join('\n')).toContain('Capture is set up for Claude Code, Codex.');
    expect(err).toEqual([]);
  });

  it('sets up the agents of a sign-in with no project, and provisions and refreshes them, where the home could be no project folder', async () => {
    // A home at the user's home directory, the way `/root/.myco` sits one below a home parent: no project root may be there.
    fs.mkdirSync(claudeDir, { recursive: true });
    const homedir = spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const rig = unjoinedRig();
      expect(await run([await invite(rig)], deps(rig, { agents: () => ['claude-code'] }))).toBe(true);
      expect(read(path.join(claudeDir, 'settings.json')) ?? '').toContain('--credential registry');
      expect(out.join('\n')).toContain('Capture is set up for Claude Code.');
      out = [];
      expect(runProvision([], { mycoHome: home, cwd: root, agents: () => ['claude-code'], stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
      expect(runProvision(['--refresh'], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
      expect(out).toEqual(['Capture is set up for Claude Code.', 'Capture is set up for Claude Code.']);
      expect(err).toEqual([]);
    } finally { homedir.mockRestore(); }
  });

  it('leaves an agent whose hooks belong to another installation byte for byte as it is, names it, and sets up the rest', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const foreign = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/opt/other/bin/myco hook session-start --symbiont claude-code --myco-managed' }] }] } }, null, 2);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), foreign);
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig))).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBe(foreign);
    expect(out.join('\n')).toMatch(/Skipped Claude Code: .*another installation/);
    expect(out.join('\n')).toContain('Capture is set up for Codex.');
    expect(read(path.join(codexDir, 'hooks.json')) ?? '').toContain('--credential registry');
  });

  it('sets up nothing with --no-agents, and a later `member provision` sets them all up from the membership alone', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const rig = unjoinedRig();
    expect(await run([await invite(rig), '--no-agents'], deps(rig))).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBeNull();
    expect(out.join('\n')).not.toContain('Capture is set up');
    // What `myco upgrade` and `myco update` run keeps the choice: no agent is set up on its own.
    expect(runProvision(['--refresh'], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBeNull();
    expect(out.at(-1)).toBe('No agent is set up for Myco on this machine; `myco member provision` sets them up.');
    out = [];
    expect(runProvision([], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json')) ?? '').toContain('--credential registry');
    expect(out).toEqual(['Capture is set up for Claude Code.']);
    // Idempotent: a second run changes nothing and says the agent is already set up.
    const before = read(path.join(claudeDir, 'settings.json'));
    out = [];
    expect(runProvision([], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBe(before);
    expect(out).toEqual(['Capture is set up for Claude Code.']);
  });

  it('asks which Deployment to provision for when this machine is a member of several and no folder names one', () => {
    for (const url of ['https://one.example', 'https://two.example']) {
      writeDeploymentMembership({ serverUrl: url, token: 'a'.repeat(43), machineId: 'm', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: home } as never);
    }
    process.exitCode = 0;
    expect(runProvision([], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(false);
    expect(err.join('\n')).toContain('name one with --server');
    process.exitCode = 0;
  });
});
