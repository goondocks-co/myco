/**
 * A repository's identity read from git's own files (`utils/git-files.ts`) answers what git answers (#1561).
 *
 * For each layout, from the top, a subdirectory and a path reached through a symlink: the project root
 * (`--git-common-dir`'s parent, as `project-root.ts` resolves it), the work tree's top (`--show-toplevel`), the
 * branch and commit `HEAD` stands on (`rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`), and whether the directory is
 * a repository at all, each against git's own answer. The plain layouts are decided from the files alone; the rest
 * fall back to git, and answer the same.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { silentRepository } from '@myco/member/auto-join.js';
import { gitHead } from '@myco/member/git-facts.js';
import { isSafeProjectRoot, resolveMainRepoRoot, resolveWorktreeRoot } from '@myco/project-root.js';
import { canonicalPath, repositoryRootOf, resolveRepositoryRoot, readRepoHead, readRepoLayout, UNUSUAL } from '@myco/utils/git-files.js';
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

function submodule(superproject: string, name: string): string {
  const gitDir = path.join(superproject, '.git', 'modules', name);
  fs.mkdirSync(path.dirname(gitDir), { recursive: true });
  const top = repo(path.join(superproject, name), ['--separate-git-dir', gitDir]);
  fs.writeFileSync(path.join(top, '.git'), `gitdir: ${path.relative(top, gitDir).replaceAll('\\', '/')}\n`);
  git(top, 'config', 'core.worktree', path.relative(gitDir, top).replaceAll('\\', '/'));
  commit(top);
  const sha = git(top, 'rev-parse', 'HEAD');
  git(superproject, 'config', '-f', '.gitmodules', `submodule.${name}.path`, name);
  git(superproject, 'config', '-f', '.gitmodules', `submodule.${name}.url`, `./${name}`);
  git(superproject, 'config', `submodule.${name}.url`, top);
  git(superproject, 'add', '.gitmodules');
  git(superproject, 'update-index', '--add', '--cacheinfo', `160000,${sha},${name}`);
  expect(git(superproject, 'submodule', 'status', '--', name)).toBe(`${sha} ${name} (heads/main)`);
  expect(canonicalPath(git(top, 'rev-parse', '--show-toplevel'))).toBe(canonicalPath(top));
  return top;
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
      const r = repo(path.join(d, 'r')); commit(r);
      return submodule(r, 'vendor/lib');
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
    // Windows requires Git to verify ownership even when the ceiling permits discovery.
    expect(readRepoLayout(r, { GIT_CEILING_DIRECTORIES: r }) === UNUSUAL).toBe(process.platform === 'win32');
    const sub = path.join(r, 'sub'); fs.mkdirSync(sub);
    expect(readRepoLayout(sub, { GIT_CEILING_DIRECTORIES: r })).toBeNull();
    // Git ignores relative ceiling entries.
    expect(resolveRepositoryRoot(sub, [], { GIT_CEILING_DIRECTORIES: '..' })).toBe(r);
  });

  it.skipIf(supportsReftable)('asks git for a repository whose config names another ref storage, even where this git cannot read it', () => {
    const r = repo(path.join(base(), 'r'));
    fs.appendFileSync(path.join(r, '.git', 'config'), '[extensions]\n\trefStorage = reftable\n');
    expect(readRepoLayout(r, {})).toBe(UNUSUAL);
  });
});

describe('file-only repository attribution on Windows', () => {
  it('recognizes the case-insensitive common directory marker', () => {
    const main = path.join(base(), 'Main');
    const commonDir = path.join(main, '.GIT');
    const marker = path.join(main, '.git');
    fs.mkdirSync(marker, { recursive: true });
    if (!fs.existsSync(commonDir)) fs.symlinkSync(marker, commonDir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(repositoryRootOf({ top: path.join(base(), 'wt'), gitDir: path.join(commonDir, 'worktrees', 'wt'), commonDir })).toBe(main);
  });
  it.skipIf(process.platform !== 'win32')('reads drive letters, backslashes, relative commondir and case variants', () => {
    const parent = base();
    const main = repo(path.join(parent, 'MainCheckout'));
    commit(main);
    const wt = path.join(parent, 'LinkedCheckout');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'linked');
    const gitDir = path.join(main, '.git', 'worktrees', 'LinkedCheckout');
    // Windows resolves file pointers case-insensitively; commondir is relative to the named git directory.
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir.toUpperCase()}\n`);
    fs.writeFileSync(path.join(gitDir, 'commondir'), '..\\..\n');
    const sub = path.join(wt, 'src');
    fs.mkdirSync(sub);
    expect(main).toMatch(/^[A-Za-z]:\\/);
    for (const cwd of [wt, sub, sub.toLowerCase()]) {
      const root = resolveRepositoryRoot(cwd, [], {});
      expect(root).not.toBeNull();
      expect(canonicalPath(root!)).toBe(canonicalPath(main));
    }
    // A regular checkout retains the spelling used by its existing registry key, including 8.3 parents.
    expect(resolveRepositoryRoot(main, [], {})).toBe(main);
  });
});


describe('member repository identity', () => {
  it('keeps sibling submodules and a separate git directory as distinct work trees', () => {
    const d = base();
    const superproject = repo(path.join(d, 'super')); commit(superproject);
    for (const name of ['sub', 'sub2']) {
      const top = submodule(superproject, name);
      fs.mkdirSync(path.join(top, 'src'));
      expect(resolveRepositoryRoot(path.join(top, 'src'), [], {})).toBe(top);
      expect(resolveMemberProjectRoot(path.join(top, 'src'))).toBe(top);
    }
    const separate = repo(path.join(d, 'separate'), ['--separate-git-dir', path.join(d, 'store.git')]);
    commit(separate);
    expect(resolveRepositoryRoot(separate, [], {})).toBe(separate);
    expect(resolveMemberProjectRoot(separate)).toBe(separate);
  });

  it('keeps linked identity when another config section has a bare key', () => {
    const d = base(); const main = repo(path.join(d, 'main')); commit(main);
    const wt = path.join(d, 'wt'); git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    git(main, 'config', 'alias.bare', 'true');
    expect(git(main, 'config', '--get', 'core.bare')).toBe('false');
    // Linked pointers carry Git's long-name spelling even when the fixture parent uses an 8.3 alias.
    const expected = gitSays(wt).root;
    expect(resolveRepositoryRoot(wt, [], {})).toBe(expected);
    expect(resolveMemberProjectRoot(wt)).toBe(expected);
  });

  it('keeps a separate uppercase Git directory distinct on case-sensitive filesystems', () => {
    const d = base();
    const store = path.join(d, 'store', '.GIT');
    fs.mkdirSync(path.dirname(store));
    const main = repo(path.join(d, 'main'), ['--separate-git-dir', store]); commit(main);
    if (fs.existsSync(path.join(path.dirname(store), '.git'))) return;
    const wt = path.join(d, 'wt'); git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    expect(resolveRepositoryRoot(wt, [], {})).toBe(wt);
    expect(resolveMemberProjectRoot(wt)).toBe(wt);
  });

  it('uses a bare repository worktree top instead of the common directory parent', () => {
    const d = base();
    const source = repo(path.join(d, 'source')); commit(source);
    git(d, 'clone', '-q', '--bare', source, path.join(d, 'bare.git'));
    const wt = path.join(d, 'bare-wt');
    git(d, '--git-dir', path.join(d, 'bare.git'), 'worktree', 'add', '-q', wt);
    expect(resolveRepositoryRoot(wt, [], {})).toBe(wt);
    expect(resolveMemberProjectRoot(wt)).toBe(wt);
  });

  it('applies ceilings to discovery, below the ceiling and at the starting directory', () => {
    const d = base(); const main = repo(path.join(d, 'main')); commit(main);
    const wt = path.join(d, 'wt'); git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const sub = path.join(main, 'sub', 'deep'); fs.mkdirSync(sub, { recursive: true });
    const held = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = '/Users';
    try {
      for (const cwd of [wt, sub, main]) {
        const expected = cwd === wt ? gitSays(wt).root : main;
        expect(resolveMemberProjectRoot(cwd)).toBe(expected);
        expect(resolveRepositoryRoot(cwd)).toBe(expected);
        expect(silentRepository(cwd, { mycoHome: path.join(d, 'myco'), env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(d, 'elsewhere') } })).toBe(false);
      }
    } finally {
      if (held === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = held;
    }
  });

  it('uses the live Git verdict when environment steering leaves discovery undecided', () => {
    const d = base(); const main = repo(path.join(d, 'main')); commit(main);
    const wt = path.join(d, 'wt'); git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const sub = path.join(wt, 'src'); fs.mkdirSync(sub);
    for (const [name, value] of [['GIT_INDEX_FILE', path.join(d, 'custom-index')], ['GIT_DIR', path.join(main, '.git')]]) {
      const held = process.env[name];
      process.env[name] = value;
      try {
        expect(readRepoLayout(sub)).toBe(UNUSUAL);
        expect(resolveMemberProjectRoot(sub)).toBe(gitSays(sub).root);
        expect(silentRepository(sub, { mycoHome: path.join(d, 'myco'), env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(d, 'elsewhere') } })).toBe(false);
      } finally {
        if (held === undefined) delete process.env[name]; else process.env[name] = held;
      }
    }
  });

  it('keeps a literal main-checkout alias when Git decides steered live discovery', () => {
    const d = base(); const main = repo(path.join(d, 'main')); commit(main);
    const alias = path.join(d, 'alias'); fs.symlinkSync(main, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(main, 'src'));
    const held = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(d, 'custom-index');
    try {
      for (const cwd of [alias, path.join(alias, 'src')]) expect(resolveMemberProjectRoot(cwd)).toBe(alias);
    } finally {
      if (held === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = held;
    }
  });

  it('never scans retained worktree records during live root or eligibility reads', () => {
    const d = base(); const main = repo(path.join(d, 'main')); commit(main);
    const sub = path.join(main, 'sub'); fs.mkdirSync(sub);
    const readdir = fs.readdirSync;
    let scans = 0;
    const spy = spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (path.basename(String(args[0])) === 'worktrees') scans += 1;
      return Reflect.apply(readdir, fs, args);
    });
    try {
      expect(resolveMemberProjectRoot(sub)).toBe(main);
      expect(silentRepository(sub, { mycoHome: path.join(d, 'myco'), env: { MYCO_TEMPORARY_FOLDERS: path.join(d, 'elsewhere') } })).toBe(false);
      expect(scans).toBe(0);
    } finally { spy.mockRestore(); }
  });
});
