import fs from 'node:fs';
import path from 'node:path';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import type { LocalDeploymentPaths } from './local.js';

/** Serializes volume changes with the entire lifetime of a locally served Deployment. */
export class LocalVolume {
  constructor(private readonly paths: LocalDeploymentPaths) {}

  private acquire() {
    const parent = path.dirname(this.paths.root);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = fs.lstatSync(this.paths.root, { throwIfNoEntry: false });
    if (root !== undefined && !root.isDirectory()) throw new Error('local Deployment volume must be a directory, not a symlink');
    const lockPath = path.join(fs.realpathSync(parent), `${path.basename(this.paths.root)}.lock`);
    const entry = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (entry !== undefined && !entry.isFile()) throw new Error('local Deployment volume lock must be a regular file');
    const held = LifecycleLock.acquire(lockPath, { command: 'myco server local volume' });
    if (!held.acquired) throw new Error('local Deployment volume is in use; stop its serving process or wait for the active operation');
    return held.lock;
  }

  exclusive<T>(write: () => Promise<T>): Promise<T>;
  exclusive<T>(write: () => T): T;
  exclusive<T>(write: () => T | Promise<T>): T | Promise<T> {
    const held = this.acquire();
    try {
      const result = write();
      if (result instanceof Promise) return result.finally(() => held.release());
      held.release();
      return result;
    } catch (error) { held.release(); throw error; }
  }

  async serve<T extends { stop(): Promise<void> }>(start: () => Promise<T>): Promise<T> {
    const held = this.acquire();
    try {
      const started = await start();
      return { ...started, stop: async () => { await started.stop(); held.release(); } };
    } catch (error) { held.release(); throw error; }
  }
}
