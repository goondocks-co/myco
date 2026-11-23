import fs from 'node:fs';
import { LOCAL_SERVER_STOP } from '@goondocks/myco-shared/setup-guidance';
import path from 'node:path';
import { LifecycleLock, type LockHandle } from '@myco/utils/lifecycle-lock.js';
import type { VolumeMetaKey } from '@myco-server-worker/platform/bun/server-main.js';
import type { LocalDeploymentPaths } from './local.js';

const BACKUP_ADMISSION_LOCK = '.backup.lock';
const VOLUME_BUSY = `The local Deployment volume is in use. If the server is running, stop it. ${LOCAL_SERVER_STOP} If another operation is using it, wait for it to finish. Then run this command again.`;

/**
 * What a start does before it serves, and how the lease proves the volume did not change under it.
 *
 * `identity` is what makes a volume this volume: its Deployment id, its schema version and the database file itself. It
 * is compared at both lease exchanges, and the value serving begins on is handed to `start`.
 */
export interface VolumeStartup<T extends { stop(): Promise<void> }> {
  /** Read-only: does this volume need a startup mutation before it can serve? */
  pending(): boolean;
  /** The startup mutation, which runs under the exclusive lease. Migrations are the only one today. */
  startup(): void | Promise<void>;
  identity(): VolumeIdentity;
  /** Serving reads the accepted volume: its configuration, its secrets and its data, under the lease it will hold. */
  start(accepted: VolumeIdentity): Promise<T>;
}

/** A volume's identity, as both lease exchanges compare it. */
export interface VolumeIdentity {
  deploymentId: string | null;
  schemaVersion: string | null;
  device: number;
  inode: number;
}

/** The identity of the volume `databasePath` holds, read without changing it. An unreadable volume answers what it can. */
export function volumeIdentity(databasePath: string, read: (key: VolumeMetaKey) => string | null): VolumeIdentity {
  const stat = fs.statSync(databasePath, { throwIfNoEntry: false });
  return { deploymentId: read('deployment_id'), schemaVersion: read('version'), device: stat?.dev ?? -1, inode: stat?.ino ?? -1 };
}

const same = (left: VolumeIdentity, right: VolumeIdentity): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * The lease over one local Deployment's volume.
 *
 * Two things are serialized, and they are not the same thing:
 * - **volume identity**: every mutation of what the volume *is* — its migrations, record, secrets, owner setup and
 *   recovery — takes `<root>.lock` exclusively. Serving and an operator backup take it shared, so they coexist while no
 *   mutation can replace the volume under either of them.
 * - **serving**: one process serves a volume at a time, which `<root>.serve.lock` decides, taken exclusively and taken
 *   first, so two starts cannot both run a startup mutation.
 *
 * A start whose volume is behind the binary must mutate it, so it exchanges its shared lease for the exclusive one. It
 * is refused while a backup or another operation holds the volume: the backup keeps its snapshot's objects, and the
 * migration waits. `flock` conversion is not atomic, so both exchanges revalidate the volume's identity; a volume that
 * changed refuses the start rather than serving something it never validated.
 *
 * A lease is the kernel's: a process that dies releases it, which is why an operator backup's hold lives in the
 * database instead and outlives its process.
 */
export class LocalVolume {
  constructor(private readonly paths: LocalDeploymentPaths) {}

  private lockPath(suffix: string): string {
    const parent = path.dirname(this.paths.root);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = fs.lstatSync(this.paths.root, { throwIfNoEntry: false });
    if (root !== undefined && !root.isDirectory()) throw new Error('local Deployment volume must be a directory, not a symlink');
    const lockPath = path.join(fs.realpathSync(parent), `${path.basename(this.paths.root)}${suffix}`);
    const entry = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (entry !== undefined && !entry.isFile()) throw new Error('local Deployment volume lock must be a regular file');
    return lockPath;
  }

  private lease(mode: 'exclusive' | 'shared', suffix = '.lock', refusal = VOLUME_BUSY): LockHandle {
    const held = LifecycleLock.acquire(this.lockPath(suffix), { command: 'myco server local volume', mode });
    if (!held.acquired) throw new Error(refusal);
    return held.lock;
  }

  /** One mutation of the volume itself, with nothing else holding it. */
  exclusive<T>(write: () => Promise<T>): Promise<T>;
  exclusive<T>(write: () => T): T;
  exclusive<T>(write: () => T | Promise<T>): T | Promise<T> {
    const held = this.lease('exclusive');
    try {
      const result = write();
      if (result instanceof Promise) return result.finally(() => held.release());
      held.release();
      return result;
    } catch (error) { held.release(); throw error; }
  }

  /**
   * Read the volume under shared ownership for backups, owner inspection and status, including while it is served.
   * Replacement and startup migrations require exclusive ownership and refuse while any such read is active.
   */
  async reading<T>(read: () => Promise<T>): Promise<T> {
    const admission = this.lease('shared', BACKUP_ADMISSION_LOCK);
    try {
      const held = this.lease('shared');
      try { return await read(); } finally { held.release(); }
    } finally { admission.release(); }
  }

  /** Exclude backups before stopping a service, through the completion of its update. */
  async updating<Accepted, T>(admit: () => Accepted, update: (accepted: Accepted) => Promise<T>): Promise<T> {
    const admission = this.lease('exclusive', BACKUP_ADMISSION_LOCK,
      'native update refused before stopping: a backup or volume read is active; wait for it to finish, then run myco server update --target local');
    try {
      const volume = this.lease('shared');
      let accepted: Accepted;
      try { accepted = admit(); } finally { volume.release(); }
      return await update(accepted);
    } finally { admission.release(); }
  }

  /**
   * Bring this volume up and serve it: the only way a Deployment starts.
   *
   * The serve lock comes first, so one process runs a startup mutation. With nothing pending, serving begins under the
   * shared lease. With something pending, the shared lease is exchanged for the exclusive one, the startup mutation
   * runs there, and the lease is exchanged back; the volume's identity is compared before the mutation and again before
   * serving, so neither exchange can hand this start a volume it did not validate.
   */
  async serve<T extends { stop(): Promise<void> }>(startup: VolumeStartup<T>): Promise<T> {
    const only = LifecycleLock.acquire(this.lockPath('.serve.lock'), { command: 'myco server local serve' });
    if (!only.acquired) throw new Error('local Deployment is already served by another process');
    let volume: LockHandle | null = null;
    try {
      for (let attempt = 1; ; attempt += 1) {
        volume = this.lease('shared');
        if (!startup.pending()) break;
        const before = startup.identity();
        volume.release();
        volume = null;
        // Nothing is held here: another exclusive operation can run, and can replace this volume.
        let exclusive: LockHandle;
        try {
          exclusive = this.lease('exclusive');
        } catch {
          throw new Error('local Deployment volume is in use, and this start must migrate it; start again once the backup or operation holding it finishes');
        }
        let mutated: VolumeIdentity;
        try {
          if (!same(startup.identity(), before)) throw new Error('local Deployment volume changed while this start took its migration lease; start again');
          await startup.startup();
          mutated = startup.identity();
        } finally { exclusive.release(); }
        volume = this.lease('shared');
        if (!same(startup.identity(), mutated)) {
          throw new Error('local Deployment volume changed while this start returned to its serving lease; start again');
        }
        if (!startup.pending()) break;
        volume.release();
        volume = null;
        if (attempt >= 3) throw new Error('local Deployment volume is still behind this binary after its own startup migration; start again');
      }
      const accepted = startup.identity();
      const started = await startup.start(accepted);
      const serving = volume;
      return { ...started, stop: async () => { await started.stop(); only.lock.release(); serving.release(); } };
    } catch (error) {
      volume?.release();
      only.lock.release();
      throw error;
    }
  }
}
