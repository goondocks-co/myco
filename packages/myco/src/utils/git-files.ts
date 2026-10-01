/**
 * A repository's identity read from git's own files, with no git process: where its git directory and common
 * directory are, which branch `HEAD` names, and the commit that branch points at. A hook asks this on every run, and
 * a git process costs 5 to 20 ms a time (#1561).
 *
 * Only the plain layouts git writes by default are read here: a `.git` directory, or a `.git` file naming a worktree's
 * or a submodule's git directory, refs as loose files or in `packed-refs`. Anything else answers `UNUSUAL`, and the
 * caller asks git itself: reftable or another ref storage, a `core.worktree` or per-worktree config, a config that
 * includes another, a git directory reached from inside itself, the environment steering git's discovery
 * (`GIT_DIR`, `GIT_CEILING_DIRECTORIES`, …), a repository another user owns (git's `safe.directory` check), a
 * symbolic ref, or a `HEAD` naming anything but a branch or a commit.
 *
 * A leaf: Node built-ins only.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The answer that sends the caller to git: the layout is one this reader does not decide. */
export const UNUSUAL = Symbol('git-files: unusual layout');
export type Unusual = typeof UNUSUAL;

export interface RepoLayout {
  /** The directory holding `.git`, as reached from the start (not resolved through symlinks): git's work tree. */
  top: string;
  /** This checkout's git directory: `.git`, or the one a `.git` file names. */
  gitDir: string;
  /** The directory shared by every worktree of the repository (`commondir`), or the git directory itself. */
  commonDir: string;
}

/** Environment variables that change where git looks or what it finds. Any of them set, git is asked. */
const STEERING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];

/** Repository config that changes the layout or the ref storage: present, git is asked. */
const UNUSUAL_CONFIG = /^\s*(?:refstorage|worktree|bare\s*=\s*true|worktreeconfig)\b|^\s*\[\s*include/im;

const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH_REF = /^ref:\s*refs\/heads\/(.+)$/;

const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
};

/**
 * The repository `cwd` is in, read from its files: null when no `.git` is found above it (git would say "not a git
 * repository"), `UNUSUAL` when git must be asked.
 */
export function readRepoLayout(cwd: string, env: NodeJS.ProcessEnv = process.env): RepoLayout | null | Unusual {
  if (STEERING_ENV.some((name) => env[name] !== undefined && env[name] !== '')) return UNUSUAL;
  const start = path.resolve(cwd);
  // A directory inside a git directory is where git finds a bare repository, not a work tree.
  if (start.split(path.sep).includes('.git')) return UNUSUAL;
  for (let dir = start; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dotGit);
    } catch {
      if (path.dirname(dir) === dir) return null;
      continue;
    }
    let gitDir: string;
    if (stat.isDirectory()) {
      gitDir = dotGit;
    } else if (stat.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
      if (named === null) return UNUSUAL;
      gitDir = path.resolve(dir, named[1]);
    } else {
      return UNUSUAL;
    }
    const common = readText(path.join(gitDir, 'commondir'));
    const commonDir = common === null ? gitDir : path.resolve(gitDir, common.trim());
    const config = readText(path.join(commonDir, 'config'));
    if (config === null || UNUSUAL_CONFIG.test(config)) return UNUSUAL;
    if (path.resolve(gitDir) !== path.resolve(commonDir) && readText(path.join(gitDir, 'config.worktree')) !== null) return UNUSUAL;
    if (!ownedByThisUser(dir)) return UNUSUAL;
    return { top: dir, gitDir, commonDir };
  }
}

/** Git refuses a repository another user owns unless it is marked safe: that decision is git's to make. */
function ownedByThisUser(dir: string): boolean {
  if (typeof process.getuid !== 'function') return true;
  try { return fs.statSync(dir).uid === process.getuid(); } catch { return false; }
}

export interface RepoHead {
  /** The branch `HEAD` names, or `HEAD` itself when it names a commit (git's `rev-parse --abbrev-ref HEAD`). */
  branch: string;
  /** The commit `HEAD` resolves to. */
  headSha: string;
}

/**
 * Where `HEAD` stands, read from the layout's files: null on a branch with no commit yet (git cannot resolve `HEAD`
 * there), `UNUSUAL` when git must be asked.
 */
export function readRepoHead(layout: RepoLayout): RepoHead | null | Unusual {
  const head = readText(path.join(layout.gitDir, 'HEAD'))?.trim();
  if (head === undefined) return UNUSUAL;
  if (COMMIT.test(head)) return { branch: 'HEAD', headSha: head };
  const branch = BRANCH_REF.exec(head)?.[1];
  if (branch === undefined) return UNUSUAL;
  const ref = `refs/heads/${branch}`;
  const loose = readText(path.join(layout.commonDir, ref))?.trim();
  if (loose !== undefined) return COMMIT.test(loose) ? { branch, headSha: loose } : UNUSUAL;
  const packed = readText(path.join(layout.commonDir, 'packed-refs'));
  if (packed === null) return null;
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space > 0 && line.slice(space + 1).trim() === ref) {
      const sha = line.slice(0, space);
      return COMMIT.test(sha) ? { branch, headSha: sha } : UNUSUAL;
    }
  }
  return null;
}
