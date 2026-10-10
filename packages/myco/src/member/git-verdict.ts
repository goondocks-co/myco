/**
 * Git's verdict on a repository its files leave to git, asked once and kept (#1561).
 *
 * `locateRepo` reads most repositories from git's own files. Where it finds a `.git` but only git can confirm it (an
 * owner it cannot match with the user, which is every repository on Windows, or config that changes the layout), git
 * is asked once, with one `rev-parse`, for the work tree, the git directory and the common directory, and once where
 * its system config lives. The answer is kept under the member home, keyed by what could change it, read with `stat`:
 * - the work tree's top, the `.git` entry, the git directory, `HEAD`, the per-worktree config and the repository config,
 *   each by identity, size, mtime and change time (an owner change moves that) and owner;
 * - every config git reads `safe.directory` from: the system config where git says it is and where each git install
 *   puts one, the user's global and XDG configs (found the way git finds home), and the files `GIT_CONFIG_GLOBAL` and
 *   `GIT_CONFIG_SYSTEM` name;
 * - the git that answered: the executable a hook would run, by path and by `stat` (a different or upgraded git is
 *   another file);
 * - the environment git reads its config and its user from.
 *
 * Every later ask reads the files again, which must find the same layout from the same start with the same left to
 * confirm, and compares the key: the first hook in a repository pays for git, and later ones start none.
 *
 * Any difference in the key, a kept verdict that cannot be read or does not parse, or a key that cannot be read, asks
 * git. Only an answer git gave for a work tree is kept: a refusal, a directory outside any repository, and a git
 * directory with no work tree are asked of git every time, by the caller's own questions (`UNUSUAL`), and so is a
 * repository whose user or system config includes another file, since the key does not follow the include.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { findGitBinary, runGitAnswer } from '../utils/git.js';
import { INCLUDE_CONFIG, locateRepo, UNUSUAL, type RepoFilesDeps, type RepoLayout, type Unusual, type Unverified } from '../utils/git-files.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const GIT_VERDICTS_DIRNAME = 'git-verdicts';
/** The shape of a kept verdict: bumped whenever its fields or what they mean change (the shape is pinned by test). */
export const GIT_VERDICT_VERSION = 2;
/** A kept verdict not written again in this long is removed when another is written. */
export const GIT_VERDICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Where a repository stands, from its files or from git. */
export type RepoVerdict =
  | { from: 'files'; layout: RepoLayout }
  | {
    from: 'git';
    /** The work tree's top level, as git prints it (`--show-toplevel`). */
    top: string;
    /** The main checkout: the common directory's parent. */
    root: string;
    /** The absolute common directory Git confirmed. */
    commonDir: string;
    /** The layout read from the files, when git confirmed it: `HEAD` and refs are read from these files. */
    layout: RepoLayout | null;
  };

interface KeptVerdict {
  version: number;
  cwd: string;
  layout: RepoLayout;
  unverified: Unverified;
  /** Where git said its system config lives: part of the key. */
  sources: string[];
  key: string;
  top: string;
  root: string;
  commonDir: string;
  confirmed: boolean;
}

export interface GitVerdictDeps extends RepoFilesDeps {
  /** The home whose member directory keeps verdicts; null keeps none. Defaults to `cwd`'s, when its member directory exists. */
  mycoHome?: string | null;
  /** How git is asked. */
  askGit?: (args: string[], cwd: string) => string;
}

const VERDICT_QUERY = ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'];

/**
 * Where `cwd`'s repository stands: from the files where they decide, from a kept verdict while its key holds, and
 * otherwise from git, once. Null outside any repository; `UNUSUAL` when the caller asks git its own question.
 */
export function repoVerdict(cwd: string, env: NodeJS.ProcessEnv = process.env, deps: GitVerdictDeps = {}): RepoVerdict | null | Unusual {
  const found = locateRepo(cwd, env, deps);
  if (found === null || found === UNUSUAL) return found;
  if (found.unverified === null) return { from: 'files', layout: found.layout };

  const mycoHome = deps.mycoHome === undefined ? memberHomeOf(cwd, env) : deps.mycoHome;
  const file = mycoHome === null ? null : path.join(verdictsDir(mycoHome), `${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 32)}.json`);
  if (file !== null) {
    const kept = readPrivateJson<KeptVerdict>(file);
    if (kept.ok && holds(kept.value, cwd, found.layout, found.unverified, env)) return answer(kept.value);
  }

  const ask = deps.askGit ?? runGitAnswer;
  const sources = systemConfigOf(ask, cwd);
  // The key is read before git is asked: a change while git answers leaves a key that no longer holds.
  const key = verdictKey(found.layout, env, sources);
  let lines: string[];
  try {
    lines = ask(VERDICT_QUERY, cwd).split(/\r?\n/);
  } catch {
    return UNUSUAL;
  }
  if (lines.length !== 3 || lines.some((line) => line === '')) return UNUSUAL;
  const [top, gitDir, commonDir] = lines;
  const verdict: KeptVerdict = {
    version: GIT_VERDICT_VERSION,
    cwd,
    layout: found.layout,
    unverified: found.unverified,
    sources,
    key: key ?? '',
    top,
    root: path.resolve(cwd, commonDir, '..'),
    commonDir: path.resolve(cwd, commonDir),
    confirmed: found.unverified === 'owner'
      && sameDir(top, found.layout.top) && sameDir(path.resolve(cwd, gitDir), found.layout.gitDir) && sameDir(path.resolve(cwd, commonDir), found.layout.commonDir),
  };
  if (file !== null && mycoHome !== null && key !== null && !includesAnother([...configFiles(env), ...sources])) keep(mycoHome, file, verdict);
  return answer(verdict);
}

/**
 * Where git reads its system config: `git var GIT_CONFIG_SYSTEM` (git 2.42), or the `etc/gitconfig` beside the prefix
 * `--exec-path` names. None when git says neither.
 */
function systemConfigOf(ask: (args: string[], cwd: string) => string, cwd: string): string[] {
  try {
    return [path.resolve(ask(['var', 'GIT_CONFIG_SYSTEM'], cwd))];
  } catch { /* an older git */ }
  try {
    return [path.resolve(ask(['--exec-path'], cwd), '..', '..', 'etc', 'gitconfig')];
  } catch {
    return [];
  }
}

function answer(verdict: KeptVerdict): RepoVerdict {
  return { from: 'git', top: verdict.top, root: verdict.root, commonDir: verdict.commonDir, layout: verdict.confirmed ? verdict.layout : null };
}

function holds(kept: KeptVerdict, cwd: string, layout: RepoLayout, unverified: Unverified, env: NodeJS.ProcessEnv): boolean {
  if (kept === null || typeof kept !== 'object'
    || kept.version !== GIT_VERDICT_VERSION
    || kept.cwd !== cwd
    || kept.unverified !== unverified
    || typeof kept.layout !== 'object' || kept.layout === null
    || kept.layout.top !== layout.top || kept.layout.gitDir !== layout.gitDir || kept.layout.commonDir !== layout.commonDir
    || !Array.isArray(kept.sources) || !kept.sources.every((source) => typeof source === 'string')
    || typeof kept.top !== 'string' || kept.top === ''
    || typeof kept.root !== 'string' || kept.root === ''
    || typeof kept.commonDir !== 'string' || !path.isAbsolute(kept.commonDir) || path.dirname(kept.commonDir) !== kept.root
    || typeof kept.confirmed !== 'boolean') return false;
  const key = verdictKey(layout, env, kept.sources);
  return key !== null && kept.key === key;
}

/** Where a home keeps verdicts. */
export function verdictsDir(mycoHome: string): string {
  return path.join(memberRoot(mycoHome), GIT_VERDICTS_DIRNAME);
}

/** The home `cwd` resolves to, when its member directory exists: a lookup never creates a home. */
function memberHomeOf(cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const home = resolveMycoHome({ cwd, env });
    return fs.statSync(memberRoot(home)).isDirectory() ? home : null;
  } catch {
    return null;
  }
}

/** The environment git reads its config, its home and its user from. */
const KEY_ENV = /^(?:GIT_CONFIG\w*|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|XDG_CONFIG_HOME|SUDO_UID)$/;

/** Where each git install keeps a system config, whichever git answered: stat'd whether or not it is there. */
function systemConfigCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    const programData = env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData';
    return [path.win32.join(programFiles, 'Git', 'etc', 'gitconfig'), path.win32.join(programData, 'Git', 'config')];
  }
  return [
    '/etc/gitconfig',
    '/usr/local/etc/gitconfig',
    '/opt/homebrew/etc/gitconfig',
    '/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig',
    '/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig',
  ];
}

/** The user's home as git finds it: `HOME`, and on Windows `HOMEDRIVE` and `HOMEPATH`, then `USERPROFILE`. */
function gitHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.HOME) return env.HOME;
  if (platform === 'win32') {
    if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`;
    if (env.USERPROFILE) return env.USERPROFILE;
  }
  return os.homedir();
}

/** The user-level config files git reads, and the files the environment names in their place or the system's. */
function configFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const home = gitHome(env, platform);
  return [
    path.join(home, '.gitconfig'),
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config'),
    ...(env.GIT_CONFIG_GLOBAL ? [path.resolve(env.GIT_CONFIG_GLOBAL)] : []),
    ...(env.GIT_CONFIG_SYSTEM ? [path.resolve(env.GIT_CONFIG_SYSTEM)] : []),
  ];
}

/** Whether any of `files` includes another config (`[include]`, `[includeIf …]`), which no key follows. */
function includesAnother(files: string[]): boolean {
  return files.some((file) => {
    try { return INCLUDE_CONFIG.test(fs.readFileSync(file, 'utf-8')); } catch { return false; }
  });
}

/**
 * What could change git's verdict, read with `stat`: null when any of it cannot be read. A missing file is part of the
 * key as missing. `sources` are the system configs git named when the verdict was asked.
 */
export function verdictKey(layout: RepoLayout, env: NodeJS.ProcessEnv = process.env, sources: string[] = [], platform: NodeJS.Platform = process.platform): string | null {
  const git = findGitBinary({ platform, env, existsFile: (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } } });
  const entries: [string, 'lstat' | 'stat'][] = [
    [layout.top, 'stat'],
    [path.join(layout.top, '.git'), 'lstat'],
    [layout.gitDir, 'stat'],
    [path.join(layout.gitDir, 'HEAD'), 'stat'],
    [path.join(layout.gitDir, 'config.worktree'), 'stat'],
    [path.join(layout.commonDir, 'config'), 'stat'],
    ...configFiles(env, platform).map((file): [string, 'stat'] => [file, 'stat']),
    ...systemConfigCandidates(env, platform).map((file): [string, 'stat'] => [file, 'stat']),
    ...sources.map((file): [string, 'stat'] => [file, 'stat']),
    [git, 'stat'],
  ];
  // Each entry carries its path: a different git, or a system config git names elsewhere, is a different key.
  const parts: string[] = [];
  for (const [file, how] of entries) {
    try {
      const s = how === 'lstat' ? fs.lstatSync(file, { bigint: true }) : fs.statSync(file, { bigint: true });
      parts.push(`${file}=${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.uid}:${s.mode}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      parts.push(`${file}=-`);
    }
  }
  const keyEnv = Object.keys(env).filter((name) => KEY_ENV.test(name)).sort().map((name) => `${name}=${env[name]}`);
  return crypto.createHash('sha256').update([...parts, ...keyEnv].join('\n')).digest('hex');
}

/** Two paths naming the same directory, both resolved through symlinks (and on Windows, short names). */
function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/** Keep a verdict; one that cannot be kept is asked of git again next time. Old verdicts go when one is written. */
function keep(mycoHome: string, file: string, verdict: KeptVerdict): void {
  const cacheDir = verdictsDir(mycoHome);
  try {
    ensureMemberDir(cacheDir, mycoHome);
    writePrivateFileAtomic(file, JSON.stringify(verdict));
    const cutoff = Date.now() - GIT_VERDICT_RETENTION_MS;
    for (const name of fs.readdirSync(cacheDir)) {
      const old = path.join(cacheDir, name);
      try { if (fs.statSync(old).mtimeMs < cutoff) fs.unlinkSync(old); } catch { /* gone already */ }
    }
  } catch { /* not kept */ }
}
