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
import fs from 'node:fs';
import path from 'node:path';
import { gitExitStatusAsync, repositoryName, runGit, runGitAnswer, type GitQueryBudget } from '@myco/utils/git.js';
import { subRequestBudget, type HookBudget } from './budget.js';
import { readRepoHead, UNUSUAL } from '../utils/git-files.js';
import { repoVerdict, type GitVerdictDeps } from './git-verdict.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitFacts {
  branch?: string;
  remote?: string;
  headSha?: string;
  /** The working tree differs from `headSha`; absent when git could not say. */
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
export async function trackedChanges(cwd: string, budget: GitQueryBudget = {}): Promise<boolean | undefined> {
  const [staged, unstaged] = await Promise.all([
    gitExitStatusAsync(['-c', 'diff.autoRefreshIndex=false', 'diff', '--cached', '--quiet', '--'], cwd, budget),
    gitExitStatusAsync(['-c', 'diff.autoRefreshIndex=false', 'diff', '--quiet', '--'], cwd, budget),
  ]);
  if ((staged !== 0 && staged !== 1) || (unstaged !== 0 && unstaged !== 1)) return undefined;
  return staged === 1 || unstaged === 1;
}

/** Optional provenance receives at most this much hook time. */
export const GIT_ENRICHMENT_CAP_MS = 500;
const END_HEAD_CAP_MS = 8;
const STATUS_PREFIX_BYTES = 4096;
/** A status read must begin and finish near the boundary it describes. */
const END_STATUS_WINDOW_MS = 2_000;
export const INLINE_GIT_STATUS_CAP_MS = 15;
const STATUS_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--no-ahead-behind', '--untracked-files=normal', '--ignore-submodules=none'];

export interface GitObservation {
  cwd: string;
  branch: string | undefined;
  device: number;
  inode: number;
}

const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];
const gitRedirected = () => GIT_REDIRECTS.some((key) => Boolean(process.env[key]));

function directoryAt(cwd: string) {
  const stat = fs.statSync(cwd, { throwIfNoEntry: false });
  return stat?.isDirectory() === true ? stat : undefined;
}

function enrichmentBudget(budget: HookBudget, now: number, cap = GIT_ENRICHMENT_CAP_MS): GitQueryBudget & { deadline: number } {
  const deliveryReserve = Math.max(budget.connectTimeoutMs, budget.requestTimeoutMs);
  return { deadline: Math.min(budget.deadline - deliveryReserve, now + subRequestBudget(budget, cap, now).requestTimeoutMs) };
}

const askWithin = (budget: GitQueryBudget) => (args: string[], cwd: string): string =>
  runGitAnswer(args, cwd, (args, cwd) => runGit(args, cwd, budget));

/** Repository naming shares the hook's enrichment allowance and preserves delivery time. */
export function sessionRepositoryName(cwd: string, budget: HookBudget, now: number = Date.now()): string {
  const queryBudget = enrichmentBudget(budget, now);
  const askGit = askWithin(queryBudget);
  const verdict = repoVerdict(cwd, process.env, { askGit });
  if (verdict === UNUSUAL) return repositoryName(cwd, queryBudget);
  if (verdict === null) return repositoryName(cwd, { ...queryBudget, commonDir: null, remote: null });
  const commonDir = verdict.from === 'files' ? fs.realpathSync(verdict.layout.commonDir) : verdict.commonDir;
  return repositoryName(cwd, { ...queryBudget, commonDir });
}

/** Read HEAD at the boundary. Only unusual repository discovery needs a Git process here. */
export function endGitHead(cwd: string, budget: HookBudget, now: number) {
  const stat = directoryAt(cwd);
  if (stat === undefined) return {};
  const { headSha, branch } = gitHead(cwd, { askGit: askWithin(enrichmentBudget(budget, now, END_HEAD_CAP_MS)) });
  if (headSha === undefined) return {};
  const gitObservation: GitObservation | undefined = gitRedirected() ? undefined : { cwd: path.resolve(cwd), branch, device: stat.dev, inode: stat.ino };
  return { headSha, branch: branch === 'HEAD' ? '' : branch, gitObservation };
}

/** Read a lock-free worktree status for the HEAD captured by the hook. The porcelain headers also distinguish clean from absent output. */
export async function observedGitChanges(
  request: GitObservation, headSha: string, at: number, budget: HookBudget, inline: boolean, now: number,
): Promise<boolean | undefined> {
  const deadline = Math.min(at + END_STATUS_WINDOW_MS, budget.deadline - budget.connectTimeoutMs, inline ? now + INLINE_GIT_STATUS_CAP_MS : Infinity);
  if (deadline <= now || gitRedirected()) return undefined;
  const queryBudget = { deadline };
  const { cwd, branch, device, inode } = request;
  const askGit = askWithin(queryBudget);
  const matches = () => {
    const stat = directoryAt(cwd);
    if (stat?.dev !== device || stat?.ino !== inode) return false;
    const head = gitHead(cwd, { askGit });
    return head.headSha === headSha && head.branch === branch;
  };
  if (!matches()) return undefined;
  let prefix = Buffer.alloc(0);
  let truncated = false;
  const status = await gitExitStatusAsync(STATUS_ARGS, cwd, queryBudget, (bytes) => {
    const room = STATUS_PREFIX_BYTES - prefix.length;
    if (bytes.length > room) truncated = true;
    if (room > 0) prefix = Buffer.concat([prefix, bytes.subarray(0, room)]);
  });
  if (status !== 0 || Date.now() >= deadline || !matches()) return undefined;
  const lines = prefix.toString('utf8').split('\n');
  lines.pop();
  if (!lines.includes(`# branch.oid ${headSha}`) || !lines.includes(`# branch.head ${branch === 'HEAD' ? '(detached)' : branch}`)) return undefined;
  if (lines.some((line) => /^[12u?] /.test(line))) return true;
  return truncated ? undefined : false;
}

/** Every fact at once. */
export async function gitFacts(cwd: string): Promise<GitFacts> {
  const head = gitHead(cwd);
  if (head.branch === undefined) return {};
  const remote = gitRemote(cwd);
  const dirty = head.headSha === undefined ? undefined : await trackedChanges(cwd);
  return { ...head, ...(remote !== undefined ? { remote } : {}), ...(dirty !== undefined ? { dirty } : {}) };
}
