/**
 * `myco login <url>` — the human half of #1158's join.
 *
 * What is asserted here is what a person sees and what lands on disk: a link
 * that names a Project binds it, a link that names none signs in only, and every
 * refusal is named without the link appearing in the message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { run } from '@myco/cli/login.js';
import { readDeploymentMembership, readRegistryEntry } from '@myco/member/registry.js';
import { unjoinedRig } from '../member/helpers/server.js';

describe('myco login', () => {
  let home: string;
  let root: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-home-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-root-'));
    // A project root is a git working tree; the binding path admits nothing else.
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    out = [];
    err = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const deps = (rig: ReturnType<typeof unjoinedRig>) => ({
    fetch: rig.fetch as typeof fetch,
    mycoHome: home,
    machineId: 'machine_person',
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
  });

  it('redeems a Project-bound link, binding that Project to the named root', async () => {
    const rig = unjoinedRig();
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'admin', projectId: 'proj_1' });

    expect(await run([`https://s/join#${issued.key}`, '--root', root], deps(rig))).toBe(true);

    expect(readDeploymentMembership('https://s', home)?.token).toBeTruthy();
    expect(readRegistryEntry(root, home)?.projectId).toBe('proj_1');
    expect(out.join('\n')).toContain('(admin)');
    expect(out.join('\n')).toContain('proj_1');
  });

  it('signs in on a link that names no Project, writing the membership and NO binding', async () => {
    const rig = unjoinedRig();
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member' });

    expect(await run([`https://s/join#${issued.key}`, '--root', root], deps(rig))).toBe(true);

    expect(readDeploymentMembership('https://s', home)?.token).toBeTruthy();
    // No Project was named, so nothing invented one for this root.
    expect(readRegistryEntry(root, home)).toBe(null);
    expect(out.join('\n')).toContain('myco member join');
  });

  it('reports a spent link as spent, and writes nothing', async () => {
    const rig = unjoinedRig();
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member' });
    expect(await run([`https://s/join#${issued.key}`], deps(rig))).toBe(true);

    out.length = 0;
    expect(await run([`https://s/join#${issued.key}`], deps(rig))).toBe(false);
    expect(err.join('\n')).toContain('enrollment_used');
  });

  it('names every refusal it can make on the link alone, without reaching the Deployment', async () => {
    const rig = unjoinedRig();
    let calls = 0;
    const counting = ((input: string | URL | Request, init?: RequestInit) => { calls += 1; return rig.fetch(input, init); }) as typeof fetch;
    const cases: Array<[string[], string]> = [
      [['nonsense'], 'that is not a URL'],
      [[`http://myco.example.com/join#${'k'.repeat(43)}`], 'must be https'],
      [[`https://s/enroll#${'k'.repeat(43)}`], 'path must be /join'],
      [['https://s/join'], 'carries no invitation'],
      [['https://s/join#short'], 'does not carry an invitation key'],
    ];
    for (const [args, message] of cases) {
      err.length = 0;
      expect({ args, ok: await run(args, { ...deps(rig), fetch: counting }) }).toEqual({ args, ok: false });
      expect({ args, said: err.join('\n').includes(message) }).toEqual({ args, said: true });
    }
    expect(calls).toBe(0);
  });

  it('refuses an unknown option and a second link, and never quotes what it was given', async () => {
    const rig = unjoinedRig();
    const link = `https://s/join#${'k'.repeat(43)}`;

    expect(await run([link, '--token', 'secret'], deps(rig))).toBe(false);
    expect(err.join('\n')).toContain('unknown option --token');
    expect(err.join('\n')).not.toContain('secret');

    err.length = 0;
    expect(await run([link, link], deps(rig))).toBe(false);
    expect(err.join('\n')).toContain('one invite link');
    expect(err.join('\n')).not.toContain(link);
  });

  it('prints its usage when given nothing at all', async () => {
    const rig = unjoinedRig();
    expect(await run([], deps(rig))).toBe(false);
    expect(err.join('\n')).toContain('Usage: myco login');
  });

  it('reports every refusal without touching the process exit status, which is the dispatcher\'s', async () => {
    const rig = unjoinedRig();
    // Compared against what it was, never against a literal: the exit status is a
    // global this file shares with every other file in its test process.
    const before = process.exitCode;
    for (const args of [[], ['nonsense'], ['https://s/join#short']]) {
      expect({ args, ok: await run(args, deps(rig)) }).toEqual({ args, ok: false });
      expect({ args, exitCode: process.exitCode }).toEqual({ args, exitCode: before });
    }
  });
});
