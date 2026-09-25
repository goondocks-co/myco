/**
 * One worker per Deployment per machine.
 *
 * A worker holds an exclusive lock for every address its Deployment answers at
 * for as long as it claims work. A second worker for the same Deployment —
 * started by hand beside the login service, run from another member home, or
 * inside the native `server run` process — finds a lock held and waits for it
 * rather than claiming beside the first. The lock is released by the kernel
 * when its holder exits, however it exits, so a worker that dies hands the
 * Deployment to the one waiting.
 *
 * The locks live in the machine's default home (`~/.myco`), whatever home a
 * worker's membership is read from: two homes holding memberships of one
 * Deployment are still one machine.
 */
import path from 'node:path';
import { defaultMycoHome } from '../paths/home.js';
import { deploymentKeyFor } from '../member/registry.js';
import { LifecycleLock, readLockHolder, type LockHandle, type LockHolder } from '../utils/lifecycle-lock.js';

/** Where this machine's worker locks live. */
export function workerLockDir(homeDir?: string): string {
  return path.join(defaultMycoHome(homeDir), 'worker', 'locks');
}

/** The lock a worker for the Deployment at `serverUrl` holds. */
export function workerLockPath(lockDir: string, serverUrl: string): string {
  return path.join(lockDir, `${deploymentKeyFor(serverUrl)}.lock`);
}

/** The addresses a worker locks: each once, keyed by Deployment identity rather than spelling. */
function lockPaths(lockDir: string, deploymentUrls: readonly string[]): string[] {
  return [...new Set(deploymentUrls.map((url) => workerLockPath(lockDir, url)))].sort();
}

/** What an attempt to become the Deployment's worker on this machine found. */
export type WorkerInstance =
  | { held: true; release: () => void }
  | { held: false; holder: LockHolder | null };

/**
 * Take every lock for `deploymentUrls`, or none of them.
 *
 * Taken in a fixed order and released on the first refusal, so two workers
 * naming overlapping addresses cannot each hold half and wait on the other.
 */
export function holdWorkerInstance(lockDir: string, deploymentUrls: readonly string[]): WorkerInstance {
  const held: LockHandle[] = [];
  const release = (): void => { for (const lock of held.splice(0)) lock.release(); };
  for (const lockPath of lockPaths(lockDir, deploymentUrls)) {
    const attempt = LifecycleLock.acquire(lockPath, { command: 'myco worker' });
    if (!attempt.acquired) {
      release();
      return { held: false, holder: attempt.holder };
    }
    held.push(attempt.lock);
  }
  return { held: true, release };
}

/** Whether a process with this id exists. One owned by another user still exists. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process serving the Deployment at `serverUrl` on this machine, or null
 * when none does. A holder record left by a process that was killed outright
 * names a process that no longer exists, and is read as no holder.
 */
export function workerHolder(lockDir: string, serverUrl: string): LockHolder | null {
  const holder = readLockHolder(workerLockPath(lockDir, serverUrl));
  return holder !== null && processExists(holder.pid) ? holder : null;
}
