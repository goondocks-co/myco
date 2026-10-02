/**
 * The git facts a session carries: its branch, its remote, the commit it
 * stands on, and whether tracked files differ from that commit.
 *
 * Release provenance reconciles the commit, and treats tracked changes not in
 * it as work no ref can contain. Each fact is read on its own, so a
 * repository with no remote or no commit yet still reports the others, and a
 * directory outside any repository reports none.
 *
 * Each hook reads only the facts it carries, and the cheapest way it can
 * (#1561): the branch and the commit come from git's own files
 * (`utils/git-files.ts`), once git has confirmed them where they do not decide
 * alone (`git-verdict.ts`), and git is asked only where neither does. Whether tracked files changed is git's to say, since it means
 * comparing the index and the working tree: its two questions run at once.
 */
import { gitExitStatusAsync, runGitAnswer } from '../utils/git.js';
import { readRepoHead, UNUSUAL } from '../utils/git-files.js';
import { repoVerdict, type GitVerdictDeps } from './git-verdict.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitFacts {
  branch?: string;
  remote?: string;
  headSha?: string;
  /** Tracked files differ from `headSha`; absent when git could not say. */
  dirty?: boolean;
}

const read = (args: string[], cwd: string, ask: (args: string[], cwd: string) => string = runGitAnswer): string | undefined => {
  try { return ask(args, cwd); } catch { return undefined; }
};

/**
 * Where `HEAD` stands: its branch (`HEAD` when it names a commit) and the commit it resolves to. Nothing outside a
 * repository, or on a branch with no commit yet.
 */
export function gitHead(cwd: string, deps: GitVerdictDeps = {}): Pick<GitFacts, 'branch' | 'headSha'> {
  const verdict = repoVerdict(cwd, process.env, deps);
  if (verdict === null) return {};
  const layout = verdict === UNUSUAL ? null : verdict.layout;
  if (layout !== null) {
    const head = readRepoHead(layout);
    if (head === null) return {};
    if (head !== UNUSUAL) return head;
  }
  const branch = read(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, deps.askGit);
  if (branch === undefined) return {};
  const head = read(['rev-parse', 'HEAD'], cwd, deps.askGit);
  return { branch, ...(head !== undefined && COMMIT_SHA.test(head) ? { headSha: head } : {}) };
}

/** The `origin` remote's URL, as git gives it (its `insteadOf` rewrites applied). */
export function gitRemote(cwd: string): string | undefined {
  return read(['remote', 'get-url', 'origin'], cwd);
}

/**
 * Whether tracked files differ from HEAD, staged or not; untracked files do not
 * count. Read from exit statuses, never from output a loaded machine can drop:
 * the index against HEAD, and the working tree against the index, asked at
 * once. Undefined when git could not say.
 */
export async function trackedChanges(cwd: string): Promise<boolean | undefined> {
  const [staged, unstaged] = await Promise.all([
    gitExitStatusAsync(['diff', '--cached', '--quiet', '--'], cwd),
    gitExitStatusAsync(['diff', '--quiet', '--'], cwd),
  ]);
  if (staged === 1 || unstaged === 1) return true;
  return staged === 0 && unstaged === 0 ? false : undefined;
}

/** Every fact at once. */
export async function gitFacts(cwd: string): Promise<GitFacts> {
  const head = gitHead(cwd);
  if (head.branch === undefined) return {};
  const remote = gitRemote(cwd);
  const dirty = head.headSha === undefined ? undefined : await trackedChanges(cwd);
  return { ...head, ...(remote !== undefined ? { remote } : {}), ...(dirty !== undefined ? { dirty } : {}) };
}
