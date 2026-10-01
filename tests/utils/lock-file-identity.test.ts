/**
 * Gate G4i (#1561): a lock taken on a file that was unlinked while the taker waited excludes no one, so a lock is only
 * held on the file the path names when it is granted.
 *
 * Three processes on one lock path. `first` holds the lock for a while. `waiter` blocks on it. While `waiter` waits, the
 * path is unlinked, and `late` opens the path, which creates a new file, and locks it at once. Without the identity
 * check, `waiter` wakes holding a lock on the unlinked file and runs beside `late`. With it, `waiter` takes the lock
 * again on the file the path names, and runs only after `late`. POSIX only: a lock file another process holds open
 * cannot be unlinked on Windows.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';

const LOCK_MODULE = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'utils', 'lifecycle-lock.ts');

function holder(dir: string, name: string, lockPath: string, holdMs: number): Promise<void> {
  const script = path.join(dir, `${name}.ts`);
  fs.writeFileSync(script, [
    `import fs from 'node:fs';`,
    `import { withFileLockSync } from ${JSON.stringify(LOCK_MODULE)};`,
    `const log = ${JSON.stringify(path.join(dir, 'log'))};`,
    `fs.appendFileSync(log, ${JSON.stringify(name)} + ' ready ' + Date.now() + '\\n');`,
    `withFileLockSync(${JSON.stringify(lockPath)}, () => {`,
    `  fs.appendFileSync(log, ${JSON.stringify(name)} + ' in ' + Date.now() + '\\n');`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});`,
    `  fs.appendFileSync(log, ${JSON.stringify(name)} + ' out ' + Date.now() + '\\n');`,
    `});`,
  ].join('\n'));
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  return new Promise((resolve) => child.on('exit', () => resolve()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `name` has written `edge` to the log: started, or holding the lock. */
async function reached(dir: string, name: string, edge: 'ready' | 'in'): Promise<void> {
  const log = path.join(dir, 'log');
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf-8').includes(`${name} ${edge} `)) return;
    await sleep(25);
  }
  throw new Error(`${name} never reached ${edge}`);
}

/** The spans each process held the lock for, read from the log. */
function spansOf(dir: string): Map<string, { in: number; out: number }> {
  const spans = new Map<string, { in: number; out: number }>();
  for (const line of fs.readFileSync(path.join(dir, 'log'), 'utf-8').trim().split('\n')) {
    const [name, edge, at] = line.split(' ');
    if (edge === 'ready') continue;
    const span = spans.get(name) ?? { in: 0, out: 0 };
    span[edge as 'in' | 'out'] = Number(at);
    spans.set(name, span);
  }
  return spans;
}

describe.skipIf(process.platform === 'win32')('a lock file unlinked under a waiting writer', () => {
  it('is never held by two processes at once', async () => {
    // Under /tmp: a macOS per-user $TMPDIR can make every process started in it slow to launch.
    const dir = fs.mkdtempSync(path.join('/tmp', 'myco-lock-identity-'));
    const lockPath = path.join(dir, '.sess.lock');
    const first = holder(dir, 'first', lockPath, 1_500);
    await reached(dir, 'first', 'in');
    const waiter = holder(dir, 'waiter', lockPath, 300);
    await reached(dir, 'waiter', 'ready');
    await sleep(150);
    fs.unlinkSync(lockPath);
    const late = holder(dir, 'late', lockPath, 1_500);
    await reached(dir, 'late', 'in');
    await Promise.all([first, waiter, late]);

    const spans = spansOf(dir);
    // The waiter was waiting on the first holder's file when the path went: it entered only after the first left.
    expect(spans.get('waiter')!.in).toBeGreaterThanOrEqual(spans.get('first')!.out);
    expect([...spans.keys()].sort()).toEqual(['first', 'late', 'waiter']);
    const overlaps = (a: { in: number; out: number }, b: { in: number; out: number }) => a.in < b.out && b.in < a.out;
    const waiterSpan = spans.get('waiter')!;
    const lateSpan = spans.get('late')!;
    expect({ waiterAndLateOverlap: overlaps(waiterSpan, lateSpan) }).toEqual({ waiterAndLateOverlap: false });
    // The waiter re-took the lock on the file the path names now, so it ran after `late` released it.
    expect(waiterSpan.in).toBeGreaterThanOrEqual(lateSpan.out);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('is taken again on a fresh file when its path is gone by the time the lock is granted', async () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'myco-lock-identity-'));
    const lockPath = path.join(dir, '.sess.lock');
    const first = holder(dir, 'first', lockPath, 1_000);
    await reached(dir, 'first', 'in');
    const waiter = holder(dir, 'waiter', lockPath, 1_500);
    await reached(dir, 'waiter', 'ready');
    await sleep(150);
    // Unlinked with nothing taking its place: the waiter wakes holding a lock on a file no path names.
    fs.unlinkSync(lockPath);
    await reached(dir, 'waiter', 'in');
    const after = holder(dir, 'after', lockPath, 200);
    await Promise.all([first, waiter, after]);

    const spans = spansOf(dir);
    expect(spans.get('waiter')!.in).toBeGreaterThanOrEqual(spans.get('first')!.out);
    const w = spans.get('waiter')!;
    const a = spans.get('after')!;
    expect({ waiterAndAfterOverlap: w.in < a.out && a.in < w.out }).toEqual({ waiterAndAfterOverlap: false });
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('a lifecycle lock whose file is replaced between its open and its lock', () => {
  const realOpen = fs.openSync;
  afterEach(() => { fs.openSync = realOpen; });

  it('is refused while another holder has the file the path names now, not granted on the unlinked one', () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'myco-lock-identity-'));
    const lockPath = path.join(dir, '.helper.lock');
    let other: ReturnType<typeof LifecycleLock.acquire> | undefined;
    // The first open of the path returns the old file; before the taker locks it, the path is unlinked and another
    // process (here, another open file) takes the lock on the file made in its place.
    fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...a: unknown[]) => number)(file, ...rest);
      if (file === lockPath && other === undefined) {
        other = { acquired: false, holder: null, holderPid: null };
        fs.unlinkSync(lockPath);
        other = LifecycleLock.acquire(lockPath, { command: 'the other holder' });
      }
      return fd;
    }) as typeof fs.openSync;

    const taken = LifecycleLock.acquire(lockPath, { command: 'the taker' });
    fs.openSync = realOpen;
    expect(other?.acquired).toBe(true);
    expect(taken).toMatchObject({ acquired: false, holder: { command: 'the other holder' } });
    if (other?.acquired) other.lock.release();
    // Once the other lets go, the path's file is the taker's to lock.
    const after = LifecycleLock.acquire(lockPath);
    expect(after.acquired).toBe(true);
    if (after.acquired) after.lock.release();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
