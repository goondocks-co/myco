/**
 * Git's verdict on a repository its files leave to git, asked once and kept under the member home
 * (`member/git-verdict.ts`, #1561): a repository whose owner the files cannot match with the user (every one on
 * Windows, stood in for here by an owner that cannot be read), or whose config changes what the files say.
 *
 * Git is asked once; later asks re-read the files and the key and ask none, and answer what git answered. Any change
 * to the key asks git again, as does a kept verdict that cannot be read or does not parse. Only a work tree git
 * accepted is kept.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitHead } from '@myco/member/git-facts.js';
import { isSafeProjectRoot } from '@myco/project-root.js';
import { GIT_VERDICT_RETENTION_MS, repoVerdict, verdictsDir, type GitVerdictDeps } from '@myco/member/git-verdict.js';
import { readRepoHead, UNUSUAL } from '@myco/utils/git-files.js';
import { runGitAnswer } from '@myco/utils/git.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const base = (): string => removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-git-verdict-'))));

function setup(init: (r: string) => void = () => {}) {
  const dir = base();
  const r = path.join(dir, 'r');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a\n');
  git(r, 'add', 'a.txt');
  git(r, ...IDENTITY, 'commit', '-q', '-m', 'a');
  init(r);
  const mycoHome = path.join(dir, 'home');
  fs.mkdirSync(path.join(mycoHome, 'member'), { recursive: true, mode: 0o700 });
  const asked: string[][] = [];
  const env = { HOME: path.join(dir, 'user') };
  const deps: GitVerdictDeps = {
    mycoHome,
    uid: () => null,
    askGit: (args, cwd) => { asked.push(args); return runGitAnswer(args, cwd); },
  };
  const verdict = (cwd = r) => repoVerdict(cwd, env, deps);
  const kept = () => fs.readdirSync(verdictsDir(mycoHome)).map((name) => path.join(verdictsDir(mycoHome), name));
  return { dir, r, mycoHome, asked, env, deps, verdict, kept };
}

describe('git\'s verdict on a repository whose owner the files cannot match', () => {
  it('is asked of git once, then kept: a later ask starts no git and answers the same', () => {
    const { r, asked, verdict } = setup();
    const sub = path.join(r, 'pkg');
    fs.mkdirSync(sub);
    for (const cwd of [r, sub]) {
      asked.length = 0;
      const first = verdict(cwd);
      expect(asked.length).toBe(1);
      expect(first).toEqual({
        from: 'git',
        top: git(cwd, 'rev-parse', '--show-toplevel'),
        root: path.resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'), '..'),
        layout: { top: r, gitDir: path.join(r, '.git'), commonDir: path.join(r, '.git') },
      });
      expect(verdict(cwd)).toEqual(first);
      expect(verdict(cwd)).toEqual(first);
      expect(asked.length).toBe(1);
    }
    // Confirmed, the layout's HEAD is read from its files.
    const v = verdict();
    if (v === null || v === UNUSUAL || v.layout === null) throw new Error('no confirmed layout');
    expect(readRepoHead(v.layout)).toEqual({ branch: 'main', headSha: git(r, 'rev-parse', 'HEAD') });
  });

  it('leaves where HEAD stands to the files once git has confirmed them: a session\'s head starts no git after the first', () => {
    const { r, asked, deps } = setup();
    const head = { branch: 'main', headSha: git(r, 'rev-parse', 'HEAD') };
    expect(gitHead(r, deps)).toEqual(head);
    expect(gitHead(r, deps)).toEqual(head);
    expect(asked).toEqual([['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']]);
  });

  it('answers whether a directory is a project from the kept verdict', () => {
    const { r, asked, env, deps } = setup();
    expect(isSafeProjectRoot(r, env, deps)).toBe(true);
    expect(isSafeProjectRoot(r, env, deps)).toBe(true);
    expect(asked).toEqual([['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']]);
  });

  it('is asked of git again once the config, HEAD or the .git entry changes', () => {
    const { r, asked, verdict } = setup();
    const changes: Array<[string, () => void]> = [
      ['.git/config', () => git(r, 'config', 'myco.test', 'x')],
      ['HEAD', () => git(r, 'checkout', '-q', '-b', 'other')],
      ['the .git entry', () => { const t = new Date(Date.now() + 60_000); fs.utimesSync(path.join(r, '.git'), t, t); }],
    ];
    for (const [what, change] of changes) {
      verdict();
      asked.length = 0;
      change();
      verdict();
      expect({ what, asked: asked.length }).toEqual({ what, asked: 1 });
      verdict();
      expect({ what, asked: asked.length }).toEqual({ what, asked: 1 });
    }
  });

  it('is asked of git again once anything else in its key changes', () => {
    const { dir, r, asked, env, deps } = setup((repo) => {
      git(repo, 'worktree', 'add', '-q', path.join(path.dirname(repo), 'wt'), '-b', 'wt');
    });
    const wt = path.join(dir, 'wt');
    const gitDir = path.join(r, '.git', 'worktrees', 'wt');
    const later = () => new Date(Date.now() + 120_000);
    const changes: Array<[string, () => void, NodeJS.ProcessEnv?]> = [
      ['the worktree\'s .git file', () => { const t = later(); fs.utimesSync(path.join(wt, '.git'), t, t); }],
      ['the worktree\'s git directory', () => { const t = later(); fs.utimesSync(gitDir, t, t); }],
      ['the shared config', () => git(wt, 'config', 'myco.test', String(Date.now()))],
      ['the worktree\'s HEAD', () => { const t = later(); fs.utimesSync(path.join(gitDir, 'HEAD'), t, t); }],
      ['a per-worktree config appearing', () => fs.writeFileSync(path.join(gitDir, 'config.worktree'), '')],
      ['the user\'s global config appearing', () => { fs.mkdirSync(env.HOME!, { recursive: true }); fs.writeFileSync(path.join(env.HOME!, '.gitconfig'), ''); }],
      ['the user\'s XDG config appearing', () => { fs.mkdirSync(path.join(env.HOME!, '.config', 'git'), { recursive: true }); fs.writeFileSync(path.join(env.HOME!, '.config', 'git', 'config'), ''); }],
      ['config given in the environment', () => {}, { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }],
    ];
    let current: NodeJS.ProcessEnv = env;
    for (const [what, change, nextEnv] of changes) {
      repoVerdict(wt, current, deps);
      asked.length = 0;
      change();
      current = nextEnv ?? current;
      const v = repoVerdict(wt, current, deps);
      expect({ what, asked: asked.length }).toEqual({ what, asked: 1 });
      expect({ what, top: v !== null && v !== UNUSUAL && v.from === 'git' ? v.top : null }).toEqual({ what, top: git(wt, 'rev-parse', '--show-toplevel') });
      fs.rmSync(path.join(gitDir, 'config.worktree'), { force: true });
    }
  });

  it('reads its key before asking git: a change while git answers is asked again', () => {
    const { r, asked, env, deps } = setup();
    const changing: GitVerdictDeps = {
      ...deps,
      askGit: (args, cwd) => { asked.push(args); const answer = runGitAnswer(args, cwd); git(r, 'config', 'myco.during', String(asked.length)); return answer; },
    };
    repoVerdict(r, env, changing);
    repoVerdict(r, env, deps);
    expect(asked.length).toBe(2);
  });

  it('asks git when the kept verdict cannot be read or does not parse, and keeps git\'s answer again', () => {
    const { r, asked, verdict, kept } = setup();
    const first = verdict();
    const [file] = kept();
    const spoils: Array<[string, () => void]> = [
      ['truncated', () => fs.writeFileSync(file, '{"version":1,', { mode: 0o600 })],
      ['not an object', () => fs.writeFileSync(file, 'null', { mode: 0o600 })],
      ['another cwd\'s', () => fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(JSON.stringify(r), JSON.stringify(`${r}-other`)), { mode: 0o600 })],
      ['a stale key', () => fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/"key":"[0-9a-f]+"/, `"key":"${'0'.repeat(64)}"`), { mode: 0o600 })],
      ['another version', () => fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('"version":1', '"version":0'), { mode: 0o600 })],
      ['missing an answer', () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), top: '' }), { mode: 0o600 })],
      ['a directory', () => { fs.rmSync(file); fs.mkdirSync(file); }],
    ];
    for (const [what, spoil] of spoils) {
      verdict();
      asked.length = 0;
      spoil();
      expect({ what, verdict: verdict() }).toEqual({ what, verdict: first });
      expect({ what, asked: asked.length }).toEqual({ what, asked: 1 });
      if (fs.statSync(file).isDirectory()) fs.rmSync(file, { recursive: true });
    }
  });

  it.skipIf(process.platform === 'win32')('asks git when the kept verdict is open to other users', () => {
    const { asked, verdict, kept } = setup();
    verdict();
    fs.chmodSync(kept()[0], 0o644);
    asked.length = 0;
    verdict();
    expect(asked.length).toBe(1);
  });

  it('keeps nothing that is not a work tree git accepted: a refusal is asked every time', () => {
    const { r, asked, env, deps, mycoHome } = setup();
    const refusing: GitVerdictDeps = { ...deps, askGit: (args) => { asked.push(args); throw new Error('fatal: detected dubious ownership'); } };
    expect(repoVerdict(r, env, refusing)).toBe(UNUSUAL);
    expect(repoVerdict(r, env, refusing)).toBe(UNUSUAL);
    expect(asked.length).toBe(2);
    expect(fs.existsSync(verdictsDir(mycoHome))).toBe(false);
  });

  it('keeps a verdict only in a member home that exists: a lookup creates none', () => {
    const { r, asked, dir } = setup();
    const home = path.join(dir, 'no-home');
    const deps: GitVerdictDeps = { uid: () => null, askGit: (args, cwd) => { asked.push(args); return runGitAnswer(args, cwd); } };
    repoVerdict(r, { MYCO_HOME: home }, deps);
    repoVerdict(r, { MYCO_HOME: home }, deps);
    expect(asked.length).toBe(2);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('removes a verdict kept past its retention when another is written', () => {
    const { r, verdict, kept, mycoHome } = setup();
    verdict();
    const stale = path.join(verdictsDir(mycoHome), `${'f'.repeat(32)}.json`);
    fs.writeFileSync(stale, '{}', { mode: 0o600 });
    const old = new Date(Date.now() - GIT_VERDICT_RETENTION_MS - 60_000);
    fs.utimesSync(stale, old, old);
    verdict(r + path.sep);
    expect(kept().includes(stale)).toBe(false);
  });
});

describe('git\'s verdict on a repository whose config changes what its files say', () => {
  it('is kept, and leaves HEAD to git', () => {
    const { r, asked, env, deps } = setup((repo) => git(repo, 'config', 'extensions.worktreeConfig', 'true'));
    const owned: GitVerdictDeps = { ...deps, uid: undefined };
    const first = repoVerdict(r, env, owned);
    expect(first).toEqual({ from: 'git', top: git(r, 'rev-parse', '--show-toplevel'), root: r, layout: null });
    expect(repoVerdict(r, env, owned)).toEqual(first);
    expect(asked.length).toBe(1);
  });
});
