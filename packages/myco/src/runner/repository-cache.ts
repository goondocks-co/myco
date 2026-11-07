import { createHash } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../utils/sleep.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';
import { repositoryBranch, repositoryUrl, REPOSITORY_COMMIT_PATTERN } from '@goondocks/myco-shared/repository';

const CACHE_LOCK_RETRY_MS = 25;
const KNOWLEDGE_MIRROR_DEPTH = 1;
const PIN_REF_PREFIX = 'refs/myco/pins/';
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

/** One URL-keyed mirror writer holds its lease across refresh and creation of the run's isolated checkout. */
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
    signal.throwIfAborted();
    await sleep(CACHE_LOCK_RETRY_MS);
    signal.throwIfAborted();
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
        await git(root,['-c','gc.auto=0','-c','maintenance.auto=false','fetch','--quiet','--no-tags',
          `--depth=${KNOWLEDGE_MIRROR_DEPTH}`,url,`+refs/heads/${branch}:refs/heads/${branch}`]);
        const resolved=(await git(root,['rev-parse','--verify',`${commit ?? 'FETCH_HEAD'}^{commit}`])).trim();
        if (!REPOSITORY_COMMIT_PATTERN.test(resolved)) throw new Error('Repository mirror returned an invalid commit.');
        const pin=PIN_REF_PREFIX+resolved;
        await git(root,['update-ref',pin,resolved]);
        const pins=(await git(root,['for-each-ref','--format=%(refname)',PIN_REF_PREFIX])).split('\n').filter(Boolean);
        for (const previous of pins) {
          if (!previous.startsWith(PIN_REF_PREFIX) || !REPOSITORY_COMMIT_PATTERN.test(previous.slice(PIN_REF_PREFIX.length))) throw new Error('Repository mirror contains an invalid pin reference.');
          if (previous !== pin) await git(root,['update-ref','-d',previous]);
        }
        return resolved;
      },
    };
    return await use(mirror);
  } finally { lease.lock.release(); }
}
