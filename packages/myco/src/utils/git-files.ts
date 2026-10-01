/**
 * A repository's identity read from git's own files, with no git process: where its git directory and common
 * directory are, which branch `HEAD` names, and the commit that branch points at. A hook asks this on every run, and
 * a git process costs 5 to 20 ms a time (#1561).
 *
 * Only the plain layouts git writes by default are read here: a `.git` directory, or a `.git` file naming a worktree's
 * or a submodule's git directory, refs as loose files or in `packed-refs`, all reached from a directory inside the work
 * tree on the same filesystem. Anything else answers `UNUSUAL`, and the caller asks git itself:
 * - where git would look elsewhere: the start reached through a symlink leading out of the work tree, a filesystem
 *   boundary crossed on the way up (git stops there), a `.git` that is not a git directory (no `HEAD`, `objects` or
 *   `refs`; git walks on past it), a directory inside a git directory, or the environment steering git's discovery
 *   (`GIT_DIR`, `GIT_CEILING_DIRECTORIES`, …);
 * - where git might refuse: a work tree or git directory another user owns (git's `safe.directory` check), or any
 *   repository on Windows, where Git for Windows applies that check by an owner this reader cannot read;
 * - where the files say more than this reader reads: a bare repository, reftable or another ref storage, a
 *   `core.worktree` or per-worktree config, a config that includes another, a symbolic ref, or a `HEAD` naming anything
 *   but a branch or a commit.
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

/**
 * Repository config that changes the layout or the ref storage: present, git is asked. `bare` is true as git reads a
 * boolean: `true`, `yes`, `on`, `1`, or the key alone.
 */
const UNUSUAL_CONFIG = /^\s*(?:refstorage|worktree|worktreeconfig)\b|^\s*bare\s*(?:=\s*(?:true|yes|on|1)\s*)?(?:[#;].*)?$|^\s*\[\s*include/im;

/** How this reader sees the filesystem and the user: the system's, or a test's stand-in. */
export interface RepoFilesDeps {
  /** The user git compares a repository's owner with; null where no owner can be read (Windows). */
  uid?: () => number | null;
  /** The filesystem device a directory is on. */
  deviceOf?: (dir: string) => number;
  /** The user a directory belongs to. */
  ownerOf?: (dir: string) => number;
}
const systemUid = (): number | null => (process.platform === 'win32' || typeof process.getuid !== 'function' ? null : process.getuid());
const systemDevice = (dir: string): number => fs.statSync(dir).dev;
const systemOwner = (dir: string): number => fs.statSync(dir).uid;

const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH_REF = /^ref:\s*refs\/heads\/(.+)$/;

const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
};

/**
 * The repository `cwd` is in, read from its files: null when no `.git` is found above it (git would say "not a git
 * repository"), `UNUSUAL` when git must be asked.
 */
export function readRepoLayout(cwd: string, env: NodeJS.ProcessEnv = process.env, deps: RepoFilesDeps = {}): RepoLayout | null | Unusual {
  if (STEERING_ENV.some((name) => env[name] !== undefined && env[name] !== '')) return UNUSUAL;
  const uid = (deps.uid ?? systemUid)();
  // Git for Windows refuses a repository by an owner this reader cannot read: git decides there.
  if (uid === null) return UNUSUAL;
  const deviceOf = deps.deviceOf ?? systemDevice;
  const start = path.resolve(cwd);
  // A directory inside a git directory is where git finds a bare repository, not a work tree.
  if (start.split(path.sep).includes('.git')) return UNUSUAL;
  let device: number;
  try { device = deviceOf(start); } catch { return UNUSUAL; }
  for (let dir = start; ; dir = path.dirname(dir)) {
    // Git stops looking at a filesystem boundary.
    try { if (deviceOf(dir) !== device) return UNUSUAL; } catch { return UNUSUAL; }
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
    // A git directory as git recognises one: `HEAD` in it, `objects` and `refs` in the directory it shares. Git walks
    // on past any other `.git`; so does the decision, to git.
    if (!isFile(path.join(gitDir, 'HEAD')) || !isDirectory(path.join(commonDir, 'objects')) || !isDirectory(path.join(commonDir, 'refs'))) return UNUSUAL;
    const config = readText(path.join(commonDir, 'config'));
    if (config === null || UNUSUAL_CONFIG.test(config)) return UNUSUAL;
    if (path.resolve(gitDir) !== path.resolve(commonDir) && readText(path.join(gitDir, 'config.worktree')) !== null) return UNUSUAL;
    const ownerOf = deps.ownerOf ?? systemOwner;
    if (!ownedBy(dir, uid, ownerOf) || !ownedBy(gitDir, uid, ownerOf)) return UNUSUAL;
    // Reached through a symlink leading out of the work tree, the start is somewhere git looks from elsewhere.
    try {
      const real = fs.realpathSync(start);
      const top = fs.realpathSync(dir);
      if (real !== top && !real.startsWith(`${top}${path.sep}`)) return UNUSUAL;
    } catch {
      return UNUSUAL;
    }
    return { top: dir, gitDir, commonDir };
  }
}

const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isDirectory = (dir: string): boolean => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

/** Git refuses a repository another user owns unless it is marked safe: that decision is git's to make. */
function ownedBy(dir: string, uid: number, ownerOf: (dir: string) => number): boolean {
  try { return ownerOf(dir) === uid; } catch { return false; }
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
