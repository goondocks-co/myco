/**
 * The git facts a session carries: its branch, its remote and the commit it
 * was on.
 *
 * The commit is what release provenance reconciles; a branch name alone is
 * reused and cannot say whether the work shipped. Each fact is read on its
 * own, so a repository with no remote or no commit yet still reports the
 * others, and a directory outside any repository reports none.
 */
import { runGit } from '../utils/git.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitFacts {
  branch?: string;
  remote?: string;
  headSha?: string;
}

const read = (args: string[], cwd: string): string | undefined => {
  try { return runGit(args, cwd) || undefined; } catch { return undefined; }
};

export function gitFacts(cwd: string): GitFacts {
  const branch = read(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === undefined) return {};
  const head = read(['rev-parse', 'HEAD'], cwd);
  return { branch, remote: read(['remote', 'get-url', 'origin'], cwd), headSha: head !== undefined && COMMIT_SHA.test(head) ? head : undefined };
}
