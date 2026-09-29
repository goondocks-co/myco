/**
 * The git facts a session carries: its branch, its remote, the commit it
 * stands on, and whether tracked files differ from that commit.
 *
 * Release provenance reconciles the commit, and treats tracked changes not in
 * it as work no ref can contain. Each fact is read on its own, so a
 * repository with no remote or no commit yet still reports the others, and a
 * directory outside any repository reports none.
 */
import { gitExitStatus, runGitAnswer } from '../utils/git.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitFacts {
  branch?: string;
  remote?: string;
  headSha?: string;
  /** Tracked files differ from `headSha`; absent when git could not say. */
  dirty?: boolean;
}

const read = (args: string[], cwd: string): string | undefined => {
  try { return runGitAnswer(args, cwd); } catch { return undefined; }
};

/**
 * Whether tracked files differ from HEAD, staged or not; untracked files do not
 * count. Read from exit statuses, never from output a loaded machine can drop:
 * the index against HEAD, then the working tree against the index. Undefined
 * when git could not say.
 */
function trackedChanges(cwd: string): boolean | undefined {
  const staged = gitExitStatus(['diff', '--cached', '--quiet', '--'], cwd);
  const unstaged = gitExitStatus(['diff', '--quiet', '--'], cwd);
  if (staged === 1 || unstaged === 1) return true;
  return staged === 0 && unstaged === 0 ? false : undefined;
}

export function gitFacts(cwd: string): GitFacts {
  const branch = read(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === undefined) return {};
  const head = read(['rev-parse', 'HEAD'], cwd);
  const headSha = head !== undefined && COMMIT_SHA.test(head) ? head : undefined;
  const dirty = headSha === undefined ? undefined : trackedChanges(cwd);
  return { branch, remote: read(['remote', 'get-url', 'origin'], cwd), headSha, dirty };
}
