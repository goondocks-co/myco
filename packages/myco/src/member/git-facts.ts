/**
 * The git facts a session carries: its branch, its remote, the commit it
 * stands on, and whether tracked files differ from that commit.
 *
 * Release provenance reconciles the commit, and treats tracked changes not in
 * it as work no ref can contain. Each fact is read on its own, so a
 * repository with no remote or no commit yet still reports the others, and a
 * directory outside any repository reports none.
 */
import { runGit } from '../utils/git.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitFacts {
  branch?: string;
  remote?: string;
  headSha?: string;
  /** Tracked files differ from `headSha`; absent when git could not say. */
  dirty?: boolean;
}

const read = (args: string[], cwd: string): string | undefined => {
  try { return runGit(args, cwd) || undefined; } catch { return undefined; }
};

export function gitFacts(cwd: string): GitFacts {
  const branch = read(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === undefined) return {};
  const head = read(['rev-parse', 'HEAD'], cwd);
  const headSha = head !== undefined && COMMIT_SHA.test(head) ? head : undefined;
  let dirty: boolean | undefined;
  if (headSha !== undefined) {
    try { dirty = runGit(['status', '--porcelain', '--untracked-files=no'], cwd).length > 0; } catch { dirty = undefined; }
  }
  return { branch, remote: read(['remote', 'get-url', 'origin'], cwd), headSha, dirty };
}
