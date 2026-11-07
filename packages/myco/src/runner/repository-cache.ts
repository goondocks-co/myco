import { createHash } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { LifecycleLock } from '../utils/lifecycle-lock.js';
import { repositoryBranch, repositoryUrl, REPOSITORY_COMMIT_PATTERN } from '@goondocks/myco-shared/repository';

const CACHE_LOCK_RETRY_MS = 25;
type Git = (cwd: string, args: string[]) => Promise<string>;

export interface RepositoryMirror {
  root: string;
  fetch(commit?: string): Promise<string>;
}

/** Cache directories are physical private children; aliases cannot redirect mirror mutations. */
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, {recursive:true,mode:0o700});
  const stat=await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Repository cache directory must be physical.');
}

/** One URL-keyed mirror writer holds its lease across refresh and creation of the run's reference checkout. */
export async function withRepositoryMirror<T>(
  cacheRoot: string, identity: {url:string;branch:string}, signal: AbortSignal, git: Git,
  use: (mirror: RepositoryMirror) => Promise<T>,
): Promise<T> {
  const url=repositoryUrl(identity.url), branch=repositoryBranch(identity.branch);
  await privateDirectory(cacheRoot);
  const directory=join(cacheRoot,createHash('sha256').update(url).digest('hex'));
  await privateDirectory(directory);
  const lockPath=join(directory,'mirror.lock');
  let lease=LifecycleLock.acquire(lockPath,{command:'myco runner repository cache'});
  while (!lease.acquired) {
    await pause(CACHE_LOCK_RETRY_MS,undefined,{signal});
    lease=LifecycleLock.acquire(lockPath,{command:'myco runner repository cache'});
  }
  try {
    signal.throwIfAborted();
    const root=join(directory,'mirror.git');
    let present=true;
    try {
      const stat=await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Repository mirror must be a physical directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      present=false;
    }
    if (!present) {
      const staging=join(directory,'staging');
      await rm(staging,{recursive:true,force:true});
      await mkdir(staging,{mode:0o700});
      await git(staging,['init','--bare','--quiet','--template=',`--initial-branch=${branch}`]);
      await rename(staging,root);
    }
    const mirror:RepositoryMirror={
      root,
      async fetch(commit) {
        if (commit !== undefined && !REPOSITORY_COMMIT_PATTERN.test(commit)) throw new Error('Invalid repository cache commit.');
        // Persistent object references require an additive mirror with no shallow boundary or automatic pruning.
        await git(root,['-c','gc.auto=0','-c','maintenance.auto=false','fetch','--quiet','--no-tags',url,
          commit === undefined ? `+refs/heads/${branch}:refs/heads/${branch}` : `+${commit}:refs/myco/pins/${commit}`]);
        const resolved=(await git(root,['rev-parse','--verify','FETCH_HEAD^{commit}'])).trim();
        if (!REPOSITORY_COMMIT_PATTERN.test(resolved)) throw new Error('Repository mirror returned an invalid commit.');
        return resolved;
      },
    };
    return await use(mirror);
  } finally { lease.lock.release(); }
}
