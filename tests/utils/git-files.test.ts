/**
 * A repository's identity read from git's own files (`utils/git-files.ts`) answers what git answers (#1561).
 *
 * For each layout, from the top, a subdirectory and a path reached through a symlink: the project root
 * (`--git-common-dir`'s parent, as `project-root.ts` resolves it), the work tree's top (`--show-toplevel`), the
 * branch and commit `HEAD` stands on (`rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`), and whether the directory is
 * a repository at all, each against git's own answer. The plain layouts are decided from the files alone; the rest
 * fall back to git, and answer the same.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitHead } from '@myco/member/git-facts.js';
import { isSafeProjectRoot, resolveMainRepoRoot, resolveWorktreeRoot } from '@myco/project-root.js';
import { readRepoHead, readRepoLayout, UNUSUAL } from '@myco/utils/git-files.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd: string, ...args: string[]): string | undefined => { try { return git(cwd, ...args); } catch { return undefined; } };
const supportsReftable = spawnSync('git', ['init', '--help'], { encoding: 'utf-8' }).stdout?.includes('ref-format')
  && spawnSync('git', ['init', '-q', '--ref-format=reftable', path.join(os.tmpdir(), `myco-reftable-probe-${process.pid}`)]).status === 0;
if (supportsReftable) fs.rmSync(path.join(os.tmpdir(), `myco-reftable-probe-${process.pid}`), { recursive: true, force: true });

const base = (): string => removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-git-files-'))));

function repo(dir: string, init: string[] = []): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', ...init);
  return dir;
}
function commit(dir: string, name = 'a.txt'): void {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, 'add', name);
  git(dir, ...IDENTITY, 'commit', '-q', '-m', name);
}

/** What git says from `cwd`, in the shapes the member uses. */
function gitSays(cwd: string) {
  const common = tryGit(cwd, 'rev-parse', '--git-common-dir');
  const branch = tryGit(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const sha = branch === undefined ? undefined : tryGit(cwd, 'rev-parse', 'HEAD');
  return {
    root: common === undefined ? cwd : path.resolve(cwd, common, '..'),
    top: tryGit(cwd, 'rev-parse', '--show-toplevel') ?? null,
    head: branch === undefined ? {} : { branch, ...(sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? { headSha: sha } : {}) },
    repository: common !== undefined,
  };
}
const memberSays = (cwd: string) => ({ root: resolveMainRepoRoot(cwd), top: resolveWorktreeRoot(cwd), head: gitHead(cwd), repository: isSafeProjectRoot(cwd, {}) });

/**
 * Every working directory a hook may run from in `top`: the top, a subdirectory, and the top through a symlink (not
 * on Windows, where making one takes a privilege a runner does not have).
 */
function cwdsOf(top: string): string[] {
  const sub = path.join(top, 'pkg', 'src');
  fs.mkdirSync(sub, { recursive: true });
  if (process.platform === 'win32') return [top, sub];
  const link = `${top}-link`;
  fs.symlinkSync(top, link);
  return [top, sub, link, path.join(link, 'pkg')];
}

/** Each layout: how it is made, and whether the files alone decide it. */
const LAYOUTS: Array<{ name: string; make: (dir: string) => string; fromFiles: boolean }> = [
  { name: 'a regular checkout', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); return r; }, fromFiles: true },
  { name: 'packed refs', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'pack-refs', '--all'); return r; }, fromFiles: true },
  { name: 'a detached HEAD', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); commit(r, 'b.txt'); git(r, 'checkout', '-q', '--detach', 'HEAD~1'); return r; }, fromFiles: true },
  { name: 'a branch with no commit yet', make: (d) => repo(path.join(d, 'r')), fromFiles: true },
  { name: 'a branch named with a slash', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'checkout', '-q', '-b', 'feat/deep/name'); return r; }, fromFiles: true },
  {
    name: 'a linked worktree', fromFiles: true,
    make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'worktree', 'add', '-q', path.join(d, 'wt'), '-b', 'wt-branch'); return path.join(d, 'wt'); },
  },
  {
    name: 'a submodule', fromFiles: false,
    make: (d) => {
      const lib = repo(path.join(d, 'lib')); commit(lib);
      const r = repo(path.join(d, 'r')); commit(r);
      git(r, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
      return path.join(r, 'vendor', 'lib');
    },
  },
  { name: 'a config that includes another', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'config', 'include.path', 'absent.gitconfig'); return r; }, fromFiles: false },
  ...(supportsReftable ? [{ name: 'reftable refs', make: (d: string) => { const r = repo(path.join(d, 'r'), ['--ref-format=reftable']); commit(r); return r; }, fromFiles: false }] : []),
];

describe('a repository read from its own files', () => {
  for (const layout of LAYOUTS) {
    it(`answers what git answers for ${layout.name}${layout.fromFiles ? ', from the files alone' : ', by asking git'}`, () => {
      const top = layout.make(base());
      for (const cwd of cwdsOf(top)) {
        expect({ cwd, ...memberSays(cwd) }).toEqual({ cwd, ...gitSays(cwd) });
        const read = readRepoLayout(cwd, {});
        const decided = read !== UNUSUAL && read !== null && readRepoHead(read) !== UNUSUAL;
        expect({ cwd, decided }).toEqual({ cwd, decided: layout.fromFiles });
      }
    });
  }

  it('says a directory outside any repository is none, as git does', () => {
    const dir = path.join(base(), 'plain');
    fs.mkdirSync(dir);
    expect(memberSays(dir)).toEqual(gitSays(dir));
    expect(readRepoLayout(dir, {})).toBeNull();
  });

  it('asks git when the environment steers where git looks', () => {
    const r = repo(path.join(base(), 'r'));
    commit(r);
    expect(readRepoLayout(r, { GIT_DIR: path.join(r, '.git') })).toBe(UNUSUAL);
    expect(readRepoLayout(r, { GIT_CEILING_DIRECTORIES: r })).toBe(UNUSUAL);
  });

  it.skipIf(supportsReftable)('asks git for a repository whose config names another ref storage, even where this git cannot read it', () => {
    const r = repo(path.join(base(), 'r'));
    fs.appendFileSync(path.join(r, '.git', 'config'), '[extensions]\n\trefStorage = reftable\n');
    expect(readRepoLayout(r, {})).toBe(UNUSUAL);
  });
});
