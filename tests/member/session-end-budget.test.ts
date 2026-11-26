import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempMycoHome, memberRig, type MemberRig } from './helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from './helpers/hooks.js';
import { cacheDeploymentFeatures } from '@myco/member/context-cache.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';
import { deadlineBudget } from '@myco/member/budget.js';
import { findGitBinary } from '@myco/utils/git.js';
import { GIT_AT_TURN_END_FEATURE } from '@goondocks/myco-shared/member-protocol';

const route = { serverUrl: 'https://member-test.invalid', projectId: 'proj_1' };
const features = ['turn', GIT_AT_TURN_END_FEATURE] as const;
const realGit = findGitBinary();
const savedHome = process.env.MYCO_HOME;
const savedPath = process.env.PATH;
let home: string;
let repo: string;
let rig: MemberRig;
let git: (...args: string[]) => string;

beforeEach(async () => {
  home = tempMycoHome();
  process.env.MYCO_HOME = home;
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git = (...args) => execFileSync(realGit, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-qb', 'main');
  fs.writeFileSync(path.join(repo, 'tracked'), 'original\n');
  git('add', 'tracked');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  rig = await memberRig();
  registerTestMember({ mycoHome: home, root: repo, ...route, token: rig.token, tokenId: rig.tokenId, expiresAt: rig.expiresAt });
  cacheDeploymentFeatures(route.serverUrl, [...features], home);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
});

function shim(onStatus: string): string {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const real = JSON.stringify(realGit);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case " $* " in
  *" status "*) ${real} "$@" || exit $?; ${onStatus}; exit 0 ;;
esac
exec ${real} "$@"
`, { mode: 0o755 });
  return `${bin}${path.delimiter}${savedPath ?? ''}`;
}

describe.skipIf(process.platform === 'win32')('worktree observations through the end hooks', () => {
  it('delivers the commit when status times out and leaves the index writable', async () => {
    const head = git('rev-parse', 'HEAD');
    const index = path.join(repo, '.git', 'index');
    const started = path.join(home, 'status-started');
    fs.utimesSync(path.join(repo, 'tracked'), 10, 10);
    const before = fs.statSync(index).mtimeMs;
    process.env.PATH = shim(`printf yes > "${started}"; exec /bin/sleep 120`);
    const seen = recordingFetch(rig.fetch);
    await runHook('stop', { session_id: 'timeout', cwd: repo, hook_event_name: 'Stop' }, { fetch: seen.fetch });
    const spool = new MemberSpool(route, { mycoHome: home });
    const budget = deadlineBudget(Date.now());
    budget.deadline += budget.connectTimeoutMs + 250;
    const client = new ServerClient({ ...route, token: rig.token }, seen.fetch, { credentialSource: 'registry' });
    await spool.drainSession('timeout', client, budget, { force: true });
    expect(fs.existsSync(started)).toBe(true);
    process.env.PATH = savedPath;
    await spool.drainSession('timeout', client, deadlineBudget(Date.now() + 5_000), { force: true });
    const turn = seen.requests.filter(r => r.path === '/events').map(r => JSON.parse(r.body!)).find(e => e.kind === 'turn');
    expect(turn?.payload).toEqual({ phase: 'end', branch: 'main', headSha: head });
    expect(fs.statSync(index).mtimeMs).toBe(before);
    expect(fs.existsSync(`${index}.lock`)).toBe(false);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'next', '--allow-empty');
    expect(git('rev-parse', 'HEAD')).not.toBe(head);
  });

  it('keeps the boundary commit when HEAD moves while status runs', async () => {
    const old = git('rev-parse', 'HEAD');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'next', '--allow-empty');
    const next = git('rev-parse', 'HEAD');
    git('reset', '--hard', old);
    process.env.PATH = shim(`${JSON.stringify(realGit)} update-ref HEAD ${next}`);
    const seen = recordingFetch(rig.fetch);
    await runHook('session-end', { session_id: 'moved', cwd: repo, hook_event_name: 'SessionEnd' }, { helpers: 'run', fetch: seen.fetch });
    expect(git('rev-parse', 'HEAD')).toBe(next);
    const ends = seen.requests.filter(r => r.path === '/events').map(r => JSON.parse(r.body!)).filter(e => e.kind === 'session.end');
    expect(ends.at(-1)?.payload).toEqual({ endedAt: expect.any(Number), headSha: old, branch: 'main' });
  });

  it('ships boundaries from an unborn branch and a directory outside Git without inventing a commit', async () => {
    const outside = path.join(home, 'outside');
    const unborn = path.join(home, 'unborn');
    fs.mkdirSync(outside);
    execFileSync(realGit, ['init', '-qb', 'main', unborn], { stdio: 'ignore' });
    for (const cwd of [outside, unborn]) {
      registerTestMember({ mycoHome: home, root: cwd, ...route, token: rig.token, tokenId: rig.tokenId, expiresAt: rig.expiresAt });
      const seen = recordingFetch(rig.fetch);
      await runHook('stop', { session_id: path.basename(cwd), cwd, hook_event_name: 'Stop' }, { helpers: 'run', fetch: seen.fetch });
      const turns = seen.requests.filter(r => r.path === '/events').map(r => JSON.parse(r.body!)).filter(e => e.kind === 'turn');
      expect(turns.map(e => e.payload)).toEqual([{ phase: 'end' }]);
    }
  });
});
