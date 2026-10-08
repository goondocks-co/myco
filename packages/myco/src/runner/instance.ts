/**
 * One worker per Deployment per machine.
 *
 * A worker holds an exclusive lock for every address its Deployment answers at
 * for as long as it claims work. A second worker for the same Deployment —
 * started by hand beside the login service, run from another member home, or
 * from another terminal — finds a lock held and waits for it
 * rather than claiming beside the first. The lock is released by the kernel
 * when its holder exits, however it exits, so a worker that dies hands the
 * Deployment to the one waiting.
 *
 * The locks live in the machine's default home (`~/.myco`), whatever home a
 * worker's membership is read from: two homes holding memberships of one
 * Deployment are still one machine.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { defaultMycoHome } from '../paths/home.js';
import { deploymentKeyFor } from '../member/registry.js';
import { LifecycleLock, readLockHolder, type LockHandle, type LockHolder } from '../utils/lifecycle-lock.js';

/** Where this machine's worker locks live. */
export function workerLockDir(homeDir?: string): string {
  return path.join(defaultMycoHome(homeDir), 'worker', 'locks');
}

/** Origins share one lock, including path-prefixed addresses; wildcard and loopback hosts are equivalent. */
export function workerLockPath(lockDir: string, serverUrl: string): string {
  const url = new URL(serverUrl);
  if (['localhost', '[::1]', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) url.hostname = '127.0.0.1';
  return path.join(lockDir, `${deploymentKeyFor(url.origin)}.lock`);
}

export function deploymentLockPath(lockDir: string, deploymentId: string): string {
  const key = crypto.createHash('sha256').update(deploymentId).digest('hex');
  return path.join(lockDir, `deployment-${key}.lock`);
}

/** The addresses a worker locks: each once, keyed by Deployment identity rather than spelling. */
function lockPaths(lockDir: string, deploymentUrls: readonly string[]): string[] {
  return [...new Set(deploymentUrls.flatMap((url) => [workerLockPath(lockDir, url), path.join(lockDir, `${deploymentKeyFor(url)}.lock`)]))].sort();
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
export function holdWorkerInstance(lockDir: string, deploymentUrls: readonly string[], deploymentId?: string): WorkerInstance {
  const held: LockHandle[] = [];
  const release = (): void => { for (const lock of held.splice(0)) lock.release(); };
  const paths = lockPaths(lockDir, deploymentUrls);
  if (deploymentId !== undefined) paths.push(deploymentLockPath(lockDir, deploymentId));
  for (const lockPath of paths.sort()) {
    const attempt = LifecycleLock.acquire(lockPath, { command: 'myco worker' });
    if (!attempt.acquired) {
      release();
      return { held: false, holder: attempt.holder };
    }
    held.push(attempt.lock);
  }
  return { held: true, release };
}

/**
 * The process serving the Deployment at `serverUrl` on this machine, or null
 * when none does. The lock itself answers, through a shared lease that only a
 * held exclusive lock refuses; the holder record is read only once the lock
 * says someone holds it, so a record left behind by a killed process, or a pid
 * since reused, never reads as a worker.
 */
export function workerHolder(lockDir: string, serverUrl: string): LockHolder | null {
  return holderAtPath(workerLockPath(lockDir, serverUrl));
}

function holderAtPath(lockPath: string): LockHolder | null {
  if (!fs.existsSync(lockPath)) return null;
  const probe = LifecycleLock.acquire(lockPath, { mode: 'shared' });
  if (probe.acquired) {
    probe.lock.release();
    return null;
  }
  return probe.holder ?? readLockHolder(lockPath) ?? { pid: 0, startedAt: 0 };
}

/** Live URL-lock owners that advertise no authenticated Deployment lock. */
export function unclassifiedWorkerHolders(lockDir: string): LockHolder[] {
  if (!fs.existsSync(lockDir)) return [];
  const files = fs.readdirSync(lockDir).filter((name) => name.endsWith('.lock'));
  const identified = new Set(files.filter((name) => name.startsWith('deployment-'))
    .map((name) => holderAtPath(path.join(lockDir, name))?.pid).filter((pid): pid is number => pid !== undefined && pid > 0));
  const unknown = files.filter((name) => !name.startsWith('deployment-'))
    .map((name) => holderAtPath(path.join(lockDir, name))).filter((holder): holder is LockHolder => holder !== null && !identified.has(holder.pid));
  return [...new Map(unknown.map((holder) => [holder.pid, holder])).values()];
}
