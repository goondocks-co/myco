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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitHead } from '@myco/member/git-facts.js';
import { isSafeProjectRoot, resolveMainRepoRoot, resolveWorktreeRoot } from '@myco/project-root.js';
import { readRepoHead, readRepoLayout, UNUSUAL } from '@myco/utils/git-files.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';
import { supportsGitReftable } from '../helpers/git-capabilities.ts';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd: string, ...args: string[]): string | undefined => { try { return git(cwd, ...args); } catch { return undefined; } };
const supportsReftable = supportsGitReftable();

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
 * Every working directory a hook may run from in `top`: the top, a subdirectory, the top through a symlink beside it,
 * and the top through a symlink to the directory above it, where a relative path resolved from the top as reached
 * lands somewhere else than from the real top (not on Windows, where making a symlink takes a privilege a runner does
 * not have).
 */
function cwdsOf(top: string, parent: string): string[] {
  const sub = path.join(top, 'pkg', 'src');
  fs.mkdirSync(sub, { recursive: true });
  if (process.platform === 'win32') return [top, sub];
  const link = `${top}-link`;
  fs.symlinkSync(top, link);
  const alias = `${parent}-alias`;
  fs.symlinkSync(parent, alias);
  removeWhenTestsEnd(alias);
  const viaAlias = path.join(alias, path.relative(parent, top));
  return [top, sub, link, path.join(link, 'pkg'), viaAlias, path.join(viaAlias, 'pkg')];
}

/** Each layout: how it is made, and whether the files alone decide it. */
const LAYOUTS: Array<{ name: string; make: (dir: string) => string; fromFiles: boolean }> = [
  { name: 'a regular checkout', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); return r; }, fromFiles: true },
  { name: 'packed refs', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'pack-refs', '--all'); return r; }, fromFiles: true },
  { name: 'packed refs, then a new commit (the loose ref is newer)', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'pack-refs', '--all'); commit(r, 'b.txt'); return r; }, fromFiles: true },
  { name: 'a detached HEAD', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); commit(r, 'b.txt'); git(r, 'checkout', '-q', '--detach', 'HEAD~1'); return r; }, fromFiles: true },
  { name: 'a branch with no commit yet', make: (d) => repo(path.join(d, 'r')), fromFiles: true },
  { name: 'a branch named with a slash', make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'checkout', '-q', '-b', 'feat/deep/name'); return r; }, fromFiles: true },
  {
    name: 'a linked worktree', fromFiles: true,
    make: (d) => { const r = repo(path.join(d, 'r')); commit(r); git(r, 'worktree', 'add', '-q', path.join(d, 'wt'), '-b', 'wt-branch'); return path.join(d, 'wt'); },
  },
  {
    // As `git worktree add --relative-paths` (git 2.48) writes it, on any git.
    name: 'a linked worktree whose .git file names its git directory relatively', fromFiles: true,
    make: (d) => {
      const r = repo(path.join(d, 'r')); commit(r);
      git(r, 'worktree', 'add', '-q', path.join(d, 'wt'), '-b', 'wt-branch');
      fs.writeFileSync(path.join(d, 'wt', '.git'), `gitdir: ${path.relative(path.join(d, 'wt'), path.join(r, '.git', 'worktrees', 'wt')).replaceAll('\\', '/')}\n`);
      return path.join(d, 'wt');
    },
  },
  {
    // Git writes `commondir` relative; one naming the common directory through a symlink is resolved as git does.
    name: 'a linked worktree whose commondir names the common directory through a symlink', fromFiles: true,
    make: (d) => {
      const r = repo(path.join(d, 'r')); commit(r);
      git(r, 'worktree', 'add', '-q', path.join(d, 'wt'), '-b', 'wt-branch');
      // Windows: making a symlink takes a privilege a runner does not have, and the worktree stays as git made it.
      if (process.platform !== 'win32') {
        fs.symlinkSync(r, path.join(d, 'r-link'));
        fs.writeFileSync(path.join(r, '.git', 'worktrees', 'wt', 'commondir'), `${path.join(d, 'r-link', '.git')}\n`);
      }
      return path.join(d, 'wt');
    },
  },
  {
    // A `.git` file naming a git directory with no `commondir`, relatively.
    name: 'a checkout whose git directory is kept apart, named relatively', fromFiles: true,
    make: (d) => {
      fs.mkdirSync(path.join(d, 'store'));
      const r = repo(path.join(d, 'r'), ['--separate-git-dir', path.join(d, 'store', 'r.git')]); commit(r);
      fs.writeFileSync(path.join(r, '.git'), `gitdir: ${path.relative(r, path.join(d, 'store', 'r.git')).replaceAll('\\', '/')}\n`);
      return r;
    },
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
  ...['true', 'yes', 'on', '1', null].map((value) => ({
    name: `a repository marked bare (${value === null ? 'the key alone' : `bare = ${value}`})`, fromFiles: false,
    make: (d: string) => {
      const r = repo(path.join(d, 'r')); commit(r);
      const config = path.join(r, '.git', 'config');
      fs.writeFileSync(config, fs.readFileSync(config, 'utf-8').replace(/^\s*bare\s*=.*$/m, value === null ? '\tbare' : `\tbare = ${value}`));
      return r;
    },
  })),
  {
    name: 'a .git git cannot use, inside a repository (git walks on past it)', fromFiles: false,
    make: (d) => {
      const r = repo(path.join(d, 'r')); commit(r);
      // A config, but no HEAD, objects or refs: not a git directory, as git judges one.
      const inner = path.join(r, 'inner');
      fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
      fs.copyFileSync(path.join(r, '.git', 'config'), path.join(inner, '.git', 'config'));
      return inner;
    },
  },
  ...(supportsReftable ? [{ name: 'reftable refs', make: (d: string) => { const r = repo(path.join(d, 'r'), ['--ref-format=reftable']); commit(r); return r; }, fromFiles: false }] : []),
];

describe('a repository read from its own files', () => {
  for (const layout of LAYOUTS) {
    it(`answers what git answers for ${layout.name}${layout.fromFiles ? ', from the files alone' : ', by asking git'}`, () => {
      const parent = base();
      const top = layout.make(parent);
      for (const cwd of cwdsOf(top, parent)) {
        expect({ cwd, ...memberSays(cwd) }).toEqual({ cwd, ...gitSays(cwd) });
        const read = readRepoLayout(cwd, {});
        const decided = read !== UNUSUAL && read !== null && readRepoHead(read) !== UNUSUAL;
        // On Windows git is always asked: Git for Windows refuses a repository by an owner this reader cannot read.
        expect({ cwd, decided }).toEqual({ cwd, decided: layout.fromFiles && process.platform !== 'win32' });
      }
    });
  }

  it('asks git from inside a git directory, where git finds no work tree', () => {
    const r = repo(path.join(base(), 'r'));
    commit(r);
    const inside = path.join(r, '.git', 'refs');
    expect(memberSays(inside)).toEqual(gitSays(inside));
    expect(readRepoLayout(inside, {})).toBe(UNUSUAL);
  });

  it.skipIf(process.platform === 'win32')('answers as git does through a symlink leading out of the work tree: to a plain folder, and into another repository', () => {
    const d = base();
    const r = repo(path.join(d, 'r'));
    commit(r);
    const plain = path.join(d, 'plain');
    fs.mkdirSync(plain);
    const other = repo(path.join(d, 'other'));
    commit(other);
    fs.mkdirSync(path.join(other, 'sub'));
    fs.symlinkSync(plain, path.join(r, 'to-plain'));
    fs.symlinkSync(path.join(other, 'sub'), path.join(r, 'to-other'));
    for (const cwd of [path.join(r, 'to-plain'), path.join(r, 'to-other')]) {
      expect({ cwd, ...memberSays(cwd) }).toEqual({ cwd, ...gitSays(cwd) });
      expect({ cwd, read: readRepoLayout(cwd, {}) }).toEqual({ cwd, read: UNUSUAL });
    }
  });

  it.skipIf(process.platform === 'win32')('asks git about a repository another user owns: its work tree, or its git directory', () => {
    const r = repo(path.join(base(), 'r'));
    commit(r);
    const mine = process.getuid!();
    expect(readRepoLayout(r, {}, { uid: () => mine })).not.toBe(UNUSUAL);
    expect(readRepoLayout(r, {}, { uid: () => mine + 1 })).toBe(UNUSUAL);
    // The work tree is the user's and the git directory another's, or the other way round: git refuses either.
    const owner = (other: string) => (dir: string) => (dir === other ? mine + 1 : mine);
    expect(readRepoLayout(r, {}, { uid: () => mine, ownerOf: owner(path.join(r, '.git')) })).toBe(UNUSUAL);
    expect(readRepoLayout(r, {}, { uid: () => mine, ownerOf: owner(r) })).toBe(UNUSUAL);
    // A linked worktree's `.git` file, which git checks as well.
    const wt = path.join(path.dirname(r), 'wt');
    git(r, 'worktree', 'add', '-q', wt, '-b', 'wt');
    expect(readRepoLayout(wt, {}, { uid: () => mine })).not.toBe(UNUSUAL);
    expect(readRepoLayout(wt, {}, { uid: () => mine, ownerOf: owner(path.join(wt, '.git')) })).toBe(UNUSUAL);
  });

  it('asks git where no owner can be read, as on Windows, whose git refuses a repository by its owner', () => {
    const r = repo(path.join(base(), 'r'));
    commit(r);
    expect(readRepoLayout(r, {}, { uid: () => null })).toBe(UNUSUAL);
  });

  it('asks git when the way up crosses a filesystem boundary, where git stops', () => {
    const r = repo(path.join(base(), 'r'));
    commit(r);
    const mounted = path.join(r, 'volume');
    fs.mkdirSync(mounted);
    const uid = () => (process.platform === 'win32' ? 0 : process.getuid!());
    expect(readRepoLayout(mounted, {}, { uid, deviceOf: () => 1 })).not.toBe(UNUSUAL);
    expect(readRepoLayout(mounted, {}, { uid, deviceOf: (dir) => (dir === mounted ? 2 : 1) })).toBe(UNUSUAL);
  });

  it('says a directory outside any repository is none, as git does', () => {
    const dir = path.join(base(), 'plain');
    fs.mkdirSync(dir);
    expect(memberSays(dir)).toEqual(gitSays(dir));
    // From the files, on Windows too: with no `.git` above it, git has no repository to refuse.
    expect(readRepoLayout(dir, {})).toBe(null);
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
