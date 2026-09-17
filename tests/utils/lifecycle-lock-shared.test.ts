/**
 * The two lease modes of the volume lock, on whichever platform runs this.
 *
 * A shared lease is what a serving Deployment and an operator backup hold: they coexist, and every exclusive mutation
 * is refused while either holds it. A shared holder owns nothing in the lock file, so a crashed exclusive holder's
 * record survives a shared lease taken over it. `flock` and `LockFileEx` are different primitives, so this runs on
 * every platform the product supports rather than standing on a POSIX pass.
 */
import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleLock, readLockHolder } from '@myco/utils/lifecycle-lock.js';

const lockRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lease-'));

it('lets shared leases coexist and refuses every exclusive one while they are held', () => {
  const root = lockRoot();
  const lockPath = path.join(root, 'volume.lock');
  try {
    const first = LifecycleLock.acquire(lockPath, { mode: 'shared' });
    const second = LifecycleLock.acquire(lockPath, { mode: 'shared' });
    expect([first.acquired, second.acquired]).toEqual([true, true]);
    expect(LifecycleLock.acquire(lockPath).acquired).toBe(false);
    if (!first.acquired || !second.acquired) throw new Error('unreachable');
    first.lock.release();
    // One shared lease still held: a mutation is still refused.
    expect(LifecycleLock.acquire(lockPath).acquired).toBe(false);
    second.lock.release();
    const exclusive = LifecycleLock.acquire(lockPath);
    expect(exclusive.acquired).toBe(true);
    // And an exclusive lease excludes a shared one.
    expect(LifecycleLock.acquire(lockPath, { mode: 'shared' }).acquired).toBe(false);
    if (exclusive.acquired) exclusive.lock.release();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('writes, truncates and updates nothing under a shared lease', () => {
  const root = lockRoot();
  const lockPath = path.join(root, 'volume.lock');
  try {
    // What a crashed exclusive holder leaves behind.
    const record = { pid: 424242, startedAt: Math.floor(Date.now() / 1000), command: 'a holder that died' };
    fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
    const bytes = fs.readFileSync(lockPath);
    const shared = LifecycleLock.acquire(lockPath, { mode: 'shared' });
    if (!shared.acquired) throw new Error('a shared lease over a dead holder must be granted');
    expect(() => shared.lock.update({ port: 1 })).toThrow('writes no holder record');
    expect(fs.readFileSync(lockPath).equals(bytes)).toBe(true);
    shared.lock.release();
    expect(fs.readFileSync(lockPath).equals(bytes)).toBe(true);
    expect(readLockHolder(lockPath)?.pid).toBe(record.pid);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses an exclusive lease while another process holds a shared one, and grants it once that process is gone', async () => {
  const root = lockRoot();
  const lockPath = path.join(root, 'volume.lock');
  const heldMarker = path.join(root, 'held.json');
  const stopMarker = path.join(root, 'stop');
  const holder = Bun.spawn(['bun', path.join(import.meta.dir, '..', 'helpers', 'lifecycle-lease-holder.ts'), lockPath, 'shared', heldMarker, stopMarker], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(heldMarker) && Date.now() < deadline) await Bun.sleep(20);
    expect(JSON.parse(fs.readFileSync(heldMarker, 'utf8')).acquired).toBe(true);
    expect(LifecycleLock.acquire(lockPath).acquired).toBe(false);
    // A shared lease of this process coexists with the other process's.
    const alongside = LifecycleLock.acquire(lockPath, { mode: 'shared' });
    expect(alongside.acquired).toBe(true);
    if (alongside.acquired) alongside.lock.release();
    // The kernel releases a lease when its process dies, however it dies.
    holder.kill(9);
    await holder.exited;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const exclusive = LifecycleLock.acquire(lockPath);
      if (exclusive.acquired) { exclusive.lock.release(); return; }
      await Bun.sleep(100);
    }
    throw new Error('the lease outlived the process that held it');
  } finally {
    holder.kill(9);
    await holder.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
