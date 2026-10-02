/**
 * Git's verdict on a repository its files leave to git, asked once and kept (#1561).
 *
 * `locateRepo` reads most repositories from git's own files. Where it finds a `.git` but only git can confirm it (an
 * owner it cannot match with the user, which is every repository on Windows, or config that changes the layout), git
 * is asked once, with one `rev-parse`, for the work tree, the git directory and the common directory. The answer is
 * kept under the member home, keyed by what could change it: the `.git` entry's identity, its mtime and its change
 * time (an owner change moves that), the git directory's, `HEAD`'s and the config's, the user's global config, and
 * the environment git reads its config from. Every later ask reads the files again, which must find the same layout
 * from the same start with the same left to confirm, and compares the key with a few `stat` calls: the first hook in a
 * repository pays for git, and later ones start none.
 *
 * Any difference in the key, a cache file that cannot be read or does not parse, or a key that cannot be read, asks
 * git. Only an answer git gave for a work tree is kept: a refusal, a directory outside any repository, and a git
 * directory with no work tree are asked of git every time, by the caller's own questions (`UNUSUAL`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { runGitAnswer } from '../utils/git.js';
import { locateRepo, UNUSUAL, type RepoFilesDeps, type RepoLayout, type Unusual, type Unverified } from '../utils/git-files.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const GIT_VERDICTS_DIRNAME = 'git-verdicts';
export const GIT_VERDICT_VERSION = 1;
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
    /** The layout read from the files, when git confirmed it: `HEAD` and refs are read from these files. */
    layout: RepoLayout | null;
  };

interface KeptVerdict {
  version: number;
  cwd: string;
  layout: RepoLayout;
  unverified: Unverified;
  key: string;
  top: string;
  root: string;
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
  // The key is read before git is asked: a change while git answers leaves a key that no longer holds.
  const key = verdictKey(found.layout, env);
  if (file !== null && key !== null) {
    const kept = readPrivateJson<KeptVerdict>(file);
    if (kept.ok && holds(kept.value, cwd, found.layout, found.unverified, key)) return answer(kept.value);
  }

  let lines: string[];
  try {
    lines = (deps.askGit ?? runGitAnswer)(VERDICT_QUERY, cwd).split(/\r?\n/);
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
    key: key ?? '',
    top,
    root: path.resolve(cwd, commonDir, '..'),
    confirmed: found.unverified === 'owner'
      && sameDir(top, found.layout.top) && sameDir(path.resolve(cwd, gitDir), found.layout.gitDir) && sameDir(path.resolve(cwd, commonDir), found.layout.commonDir),
  };
  if (file !== null && mycoHome !== null && key !== null) keep(mycoHome, file, verdict);
  return answer(verdict);
}

function answer(verdict: KeptVerdict): RepoVerdict {
  return { from: 'git', top: verdict.top, root: verdict.root, layout: verdict.confirmed ? verdict.layout : null };
}

function holds(kept: KeptVerdict, cwd: string, layout: RepoLayout, unverified: Unverified, key: string): boolean {
  return kept !== null && typeof kept === 'object'
    && kept.version === GIT_VERDICT_VERSION
    && kept.cwd === cwd
    && kept.unverified === unverified
    && typeof kept.layout === 'object' && kept.layout !== null
    && kept.layout.top === layout.top && kept.layout.gitDir === layout.gitDir && kept.layout.commonDir === layout.commonDir
    && kept.key === key
    && typeof kept.top === 'string' && kept.top !== ''
    && typeof kept.root === 'string' && kept.root !== ''
    && typeof kept.confirmed === 'boolean';
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

/** The environment git reads its config, and so its `safe.directory` list, from. */
const CONFIG_ENV = /^(?:GIT_CONFIG\w*|HOME|USERPROFILE|XDG_CONFIG_HOME)$/;

/**
 * What could change git's verdict, read with `stat`: null when any of it cannot be read. A missing file is part of the
 * key as missing.
 */
export function verdictKey(layout: RepoLayout, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const xdg = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const dotGit = path.join(layout.top, '.git');
  const entries: [string, 'lstat' | 'stat'][] = [
    [dotGit, 'lstat'],
    [layout.gitDir, 'stat'],
    [path.join(layout.gitDir, 'HEAD'), 'stat'],
    [path.join(layout.commonDir, 'config'), 'stat'],
    [path.join(home, '.gitconfig'), 'stat'],
    [path.join(xdg, 'git', 'config'), 'stat'],
  ];
  const parts: string[] = [];
  for (const [file, how] of entries) {
    try {
      const s = how === 'lstat' ? fs.lstatSync(file, { bigint: true }) : fs.statSync(file, { bigint: true });
      parts.push(`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.uid}:${s.mode}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      parts.push('-');
    }
  }
  const configEnv = Object.keys(env).filter((name) => CONFIG_ENV.test(name)).sort().map((name) => `${name}=${env[name]}`);
  return crypto.createHash('sha256').update([...parts, ...configEnv].join('\n')).digest('hex');
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
