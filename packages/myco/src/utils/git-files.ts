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
 *   (`GIT_DIR`, `GIT_WORK_TREE`, …);
 * - where the files say more than this reader reads: a config that includes another, a symbolic ref, or a `HEAD`
 *   naming anything but a branch or a commit.
 *
 * Two more leave a `.git` found but unconfirmed (`locateRepo`'s `unverified`), which git confirms once and the member
 * keeps (`member/git-verdict.ts`): `owner`, where git might refuse a work tree or git directory another user owns
 * (its `safe.directory` check), which is any repository on Windows, where Git for Windows applies that check by an
 * owner this reader cannot read; and `config`, a bare repository, reftable or another ref storage, or a
 * `core.worktree` or per-worktree config.
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
const STEERING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];

/**
 * Repository config that changes the layout or the ref storage: present, git is asked. `bare` is true as git reads a
 * boolean: `true`, `yes`, `on`, `1`, or the key alone.
 */
const UNUSUAL_CONFIG = /^\s*(?:refstorage|worktree|worktreeconfig)\b|^\s*bare\s*(?:=\s*(?:true|yes|on|1)\s*)?(?:[#;].*)?$/im;
/** A config that includes another (`[include]`, `[includeIf …]`). */
export const INCLUDE_CONFIG = /^\s*\[\s*include/im;

/** How this reader sees the filesystem and the user: the system's, or a test's stand-in. */
export interface RepoFilesDeps {
  /** Read directory identity only; config and Git's execution trust policy do not change these pointers. */
  layoutOnly?: boolean;
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
  const found = locateRepo(cwd, env, deps);
  if (found === null || found === UNUSUAL) return found;
  return found.unverified === null ? found.layout : UNUSUAL;
}

/** Linked worktrees share their non-bare main checkout; identity comparisons use canonicalRootIdentity. */
export function repositoryRootOf(layout: RepoLayout, opts: { discoveredByGit?: boolean } = {}): string {
  const bare = repositoryIsBare(layout.commonDir);
  // GIT_DIR alone makes Git report cwd as top; a non-bare .git still names the main checkout.
  return (opts.discoveredByGit || layout.gitDir !== layout.commonDir) && isMainGitDirectory(layout.commonDir) && !bare
    ? path.dirname(layout.commonDir) : layout.top;
}

/** The `.git` marker also accepts alternate case when both spellings name the same directory. */
function isMainGitDirectory(directory: string): boolean {
  const name = path.basename(directory);
  if (name === '.git') return true;
  if (name.toLowerCase() !== '.git') return false;
  try {
    const actual = fs.statSync(directory);
    const marker = fs.statSync(path.join(path.dirname(directory), '.git'));
    return actual.dev === marker.dev && actual.ino === marker.ino;
  } catch { return false; }
}

/** Git's core.bare boolean; repeated values use the last assignment in the core section. */
function repositoryIsBare(commonDir: string): boolean {
  let core = false;
  let bare = false;
  for (const line of (readText(path.join(commonDir, 'config')) ?? '').split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (section !== null) { core = section[1].toLowerCase() === 'core'; continue; }
    if (!core) continue;
    const entry = /^\s*bare\s*(?:=\s*(.*?))?\s*(?:[#;].*)?$/i.exec(line);
    if (entry !== null) bare = entry[1] === undefined || /^(?:true|yes|on|1)$/i.test(entry[1].replace(/^"(.*)"$/, '$1').trim());
  }
  return bare;
}

type RetainedRecord = { worktree: string; root: string };

/** Retained records are read once per import placer, only when a missing directory needs them. */
export function repositoryRootResolver(roots: Iterable<string>, env: NodeJS.ProcessEnv = process.env): (cwd: string) => string | null {
  const retainedRoots = [...roots];
  let records: RetainedRecord[] | undefined;
  return (cwd) => resolveRepositoryRoot(cwd, [], env, {
    retained: () => records ??= retainedWorktreeRecords(retainedRoots, env),
  });
}

/** The main checkout named by Git's files; retained worktree records resolve missing working directories. */
export function resolveRepositoryRoot(
  cwd: string, retainedRoots: Iterable<string> = [], env: NodeJS.ProcessEnv = process.env,
  opts: { unusual?: (cwd: string) => string | null; retained?: () => readonly RetainedRecord[] } = {},
): string | null {
  let found = locateRepo(cwd, env, { layoutOnly: true });
  if ((found === null || found === UNUSUAL) && canonicalPath(cwd) !== path.resolve(cwd)) found = locateRepo(canonicalPath(cwd), env, { layoutOnly: true });
  if (found !== null && found !== UNUSUAL) return repositoryRootOf(found.layout);
  // Existing directories require their own repository identity, even when an old record names the same path.
  if (fs.existsSync(cwd)) return found === UNUSUAL ? opts.unusual?.(cwd) ?? null : null;
  const recorded = canonicalRootIdentity(cwd);
  const matches = new Set<string>();
  for (const { worktree, root } of opts.retained?.() ?? retainedWorktreeRecords(retainedRoots, env)) {
    const relative = path.relative(canonicalRootIdentity(worktree), recorded);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) matches.add(root);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function retainedWorktreeRecords(roots: Iterable<string>, env: NodeJS.ProcessEnv): RetainedRecord[] {
  const out: RetainedRecord[] = [];
  for (const root of roots) {
    const repo = locateRepo(root, env, { layoutOnly: true });
    if (repo === null || repo === UNUSUAL) continue;
    const { commonDir } = repo.layout;
    let records: fs.Dirent[];
    try { records = fs.readdirSync(path.join(commonDir, 'worktrees'), { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const record of records) {
      if (!record.isDirectory()) continue;
      const dir = path.join(commonDir, 'worktrees', record.name);
      const pointer = readText(path.join(dir, 'gitdir'))?.trim();
      const common = readText(path.join(dir, 'commondir'))?.trim();
      if (!pointer || !common || path.basename(pointer) !== '.git') continue;
      if (canonicalRootIdentity(path.resolve(dir, common)) !== canonicalRootIdentity(commonDir)) continue;
      const worktree = canonicalPath(path.dirname(path.resolve(dir, pointer)));
      if (fs.existsSync(worktree)) {
        const current = locateRepo(worktree, env, { layoutOnly: true });
        if (current === null || current === UNUSUAL || canonicalRootIdentity(current.layout.top) !== canonicalRootIdentity(worktree)
          || canonicalRootIdentity(current.layout.gitDir) !== canonicalRootIdentity(dir)) continue;
      }
      out.push({ worktree, root: canonicalPath(root) });
    }
  }
  return out;
}

/** Existing paths use native realpath; missing paths retain their absolute spelling. */
export function canonicalPath(p: string): string {
  const absolute = path.resolve(p);
  if (!fs.existsSync(absolute)) return absolute;
  try { return fs.realpathSync.native(absolute); } catch { return absolute; }
}

type RootFileIdentity = { dev: number | bigint; ino: number | bigint; ctimeMs?: number | bigint };

export interface CanonicalRootIdentityDeps {
  realpath?: (p: string) => string;
  stat?: (p: string) => RootFileIdentity;
  lstat?: (p: string) => RootFileIdentity;
  paths?: typeof path;
  caseCache?: Map<string, { stamp: string; insensitive: boolean; volumeRoot?: string }>;
}

const pathCaseCache = new Map<string, { stamp: string; insensitive: boolean; volumeRoot?: string }>();

/** Native realpath expands aliases; case is folded only after an identity probe on the existing path. */
export function canonicalRootIdentity(p: string, deps: CanonicalRootIdentityDeps = {}): string {
  return canonicalRootDetails(p, deps).identity;
}

/** A saved spelling can name only the same literal path or a proven canonical identity. */
export function rootIdentityMayMatch(saved: string, identity: string, spelling = identity): boolean {
  try { return path.resolve(saved) === path.resolve(spelling) || canonicalRootIdentity(saved) === identity; } catch { return false; }
}

function canonicalRootDetails(p: string, deps: CanonicalRootIdentityDeps): { identity: string; insensitive: boolean } {
  const paths = deps.paths ?? path;
  const absolute = paths.resolve(p);
  let physical: string;
  try { physical = (deps.realpath ?? fs.realpathSync.native)(absolute); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = paths.dirname(absolute);
    if (parent === absolute) return { identity: absolute, insensitive: false };
    const found = canonicalRootDetails(parent, deps);
    const name = paths.basename(absolute);
    return { identity: paths.join(found.identity, found.insensitive ? name.toLowerCase() : name), insensitive: found.insensitive };
  }
  const cache = deps.caseCache ?? pathCaseCache;
  const stat = deps.stat ?? ((at: string) => fs.statSync(at, { bigint: true }));
  const lstat = deps.lstat ?? ((at: string) => fs.lstatSync(at, { bigint: true }));
  const actual = stat(physical);
  const parent = paths.dirname(physical);
  const parentStat = parent === physical ? actual : stat(parent);
  const stamp = [actual.dev, actual.ino, actual.ctimeMs, parentStat.dev, parentStat.ino, parentStat.ctimeMs].join(':');
  const cached = cache.get(physical);
  let insensitive = cached?.stamp === stamp ? cached.insensitive : undefined;
  let volumeRoot = cached?.stamp === stamp ? cached.volumeRoot ?? physical : physical;
  if (insensitive === undefined) {
    insensitive = false;
    for (let at = physical; paths.dirname(at) !== at; at = paths.dirname(at)) {
      const name = paths.basename(at);
      const flipped = name.replace(/[a-zA-Z]/, (c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
      if (flipped === name) continue;
      try {
        const original = at === physical ? actual : stat(at);
        const containing = at === physical ? parentStat : stat(paths.dirname(at));
        if (original.dev !== actual.dev || containing.dev !== actual.dev) break;
        const alternate = lstat(paths.join(paths.dirname(at), flipped));
        insensitive = original.dev === alternate.dev && original.ino === alternate.ino;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      break;
    }
    if (insensitive) {
      while (paths.dirname(volumeRoot) !== volumeRoot) {
        const parent = paths.dirname(volumeRoot);
        const containing = volumeRoot === physical ? parentStat : stat(parent);
        if (containing.dev !== actual.dev) break;
        volumeRoot = parent;
      }
    }
    cache.set(physical, { stamp, insensitive, volumeRoot });
  }
  const folded = paths.dirname(volumeRoot) === volumeRoot ? physical.toLowerCase()
    : volumeRoot + physical.slice(volumeRoot.length).toLowerCase();
  return { identity: insensitive ? folded : physical, insensitive };
}

/**
 * What git must still confirm about a layout these files found: `owner`, that it accepts a repository whose owner
 * this reader could not match with the user (another user's, or any on Windows); `config`, the layout or ref storage
 * its config changes, which only git reads.
 */
export type Unverified = 'owner' | 'config';

export interface LocatedRepo {
  layout: RepoLayout;
  /** Null when the files decide the layout; otherwise what only git can confirm. */
  unverified: Unverified | null;
}

/**
 * The `.git` git would find from `cwd`, read from its files, with what about it only git can confirm: null when no
 * `.git` is found above it, `UNUSUAL` when git might find another, or none, or read the files differently.
 */
export function locateRepo(cwd: string, env: NodeJS.ProcessEnv = process.env, deps: RepoFilesDeps = {}): LocatedRepo | null | Unusual {
  if (STEERING_ENV.some((name) => env[name] !== undefined && env[name] !== '')) return UNUSUAL;
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
      const ceilings = (env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter(path.isAbsolute);
      if (ceilings.some((ceiling) => canonicalRootIdentity(ceiling) === canonicalRootIdentity(path.dirname(dir)))) return null;
      continue;
    }
    let gitDir: string;
    if (stat.isDirectory()) {
      gitDir = dotGit;
    } else if (stat.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
      if (named === null) return UNUSUAL;
      // Git resolves the directory a `.git` file names through symlinks, and the common directory from there: a
      // relative `gitdir:` reached through a symlinked parent names the real one, not one beside the alias.
      try { gitDir = fs.realpathSync(path.resolve(dir, named[1])); } catch { return UNUSUAL; }
    } else {
      return UNUSUAL;
    }
    const common = readText(path.join(gitDir, 'commondir'));
    let commonDir = gitDir;
    if (common !== null) {
      try { commonDir = stat.isFile() ? fs.realpathSync(path.resolve(gitDir, common.trim())) : path.resolve(gitDir, common.trim()); } catch { return UNUSUAL; }
    }
    // A git directory as git recognises one: `HEAD` in it, `objects` and `refs` in the directory it shares. Git walks
    // on past any other `.git`; so does the decision, to git.
    if (!isFile(path.join(gitDir, 'HEAD')) || !isDirectory(path.join(commonDir, 'objects')) || !isDirectory(path.join(commonDir, 'refs'))) return UNUSUAL;
    const config = readText(path.join(commonDir, 'config'));
    // An included config is read from files no caller of this reader watches: git is asked every time.
    if (!deps.layoutOnly && (config === null || INCLUDE_CONFIG.test(config))) return UNUSUAL;
    const configUnusual = UNUSUAL_CONFIG.test(config ?? '')
      || (path.resolve(gitDir) !== path.resolve(commonDir) && readText(path.join(gitDir, 'config.worktree')) !== null);
    // Reached through a symlink leading out of the work tree, the start is somewhere git looks from elsewhere.
    try {
      const real = fs.realpathSync(start);
      const top = fs.realpathSync(dir);
      if (real !== top && !real.startsWith(`${top}${path.sep}`)) return UNUSUAL;
    } catch {
      return UNUSUAL;
    }
    if (deps.layoutOnly) return { layout: { top: dir, gitDir, commonDir }, unverified: null };
    // Git refuses a repository another user owns unless it is marked safe: it checks the work tree, the `.git` file
    // that names a git directory, and the git directory. Git for Windows applies that check by an owner this reader
    // cannot read.
    const uid = (deps.uid ?? systemUid)();
    const ownerOf = deps.ownerOf ?? systemOwner;
    const owned = uid !== null && ownedBy(dir, uid, ownerOf) && (!stat.isFile() || ownedBy(dotGit, uid, ownerOf)) && ownedBy(gitDir, uid, ownerOf);
    return { layout: { top: dir, gitDir, commonDir }, unverified: configUnusual ? 'config' : owned ? null : 'owner' };
  }
}

const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isDirectory = (dir: string): boolean => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

/** Whether `dir` belongs to `uid`; an owner that cannot be read is no match. */
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
