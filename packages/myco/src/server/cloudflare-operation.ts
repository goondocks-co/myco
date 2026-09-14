import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { resolveMycoHome } from '../paths/home.js';

const owners = new AsyncLocalStorage<{ path: string; active: boolean }>();

/** Serialize hosted operator changes, including nested record and staging writes. */
export function withCloudflareOperation<T>(mycoHome: string | undefined, operation: () => Promise<T>): Promise<T>;
export function withCloudflareOperation<T>(mycoHome: string | undefined, operation: () => T): T;
export function withCloudflareOperation<T>(mycoHome: string | undefined, operation: () => T | Promise<T>): T | Promise<T> {
  const parent = path.join(mycoHome ?? resolveMycoHome(), 'server');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lockPath = path.join(fs.realpathSync(parent), 'cloudflare.lock');
  const current = owners.getStore();
  if (current?.active && current.path === lockPath) return operation();
  const entry = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (entry !== undefined && !entry.isFile()) throw new Error('Cloudflare operator lock must be a regular file');
  const held = LifecycleLock.acquire(lockPath, { command: 'myco server cloudflare operation' });
  if (!held.acquired) throw new Error('Cloudflare Deployment is in use by another operator command');
  const owner = { path: lockPath, active: true };
  const release = () => { owner.active = false; held.lock.release(); };
  try {
    const result = owners.run(owner, operation);
    if (result instanceof Promise) return result.finally(release);
    release();
    return result;
  } catch (error) { release(); throw error; }
}

/** Hold ownership across every asynchronous step of a hosted lifecycle command. */
export function cloudflareOperation<Options extends { mycoHome?: string }, Result>(
  operation: (options: Options) => Promise<Result>,
): (options: Options) => Promise<Result> {
  return async (options) => withCloudflareOperation(options.mycoHome, () => operation(options));
}
