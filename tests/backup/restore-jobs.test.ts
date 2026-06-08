import { describe, it, expect } from 'bun:test';
import { RestoreJobRegistry } from '@myco/backup/restore-jobs.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const RESULT = { tables: [], total_restored: 5, total_skipped: 2 };
const ARGS = { groveId: 'g', fileName: 'f.sql', dbPath: '/db', backupPath: '/b.sql' };

describe('RestoreJobRegistry', () => {
  it('returns a running job that flips to done with the result', async () => {
    const d = deferred<typeof RESULT>();
    const reg = new RestoreJobRegistry(() => d.promise, () => 1000);
    const job = reg.start(ARGS);
    expect(job.status).toBe('running');
    expect(reg.get(job.id)?.status).toBe('running');

    d.resolve(RESULT);
    await tick();
    expect(reg.get(job.id)?.status).toBe('done');
    expect(reg.get(job.id)?.result?.total_restored).toBe(5);
    expect(reg.get(job.id)?.finished_at).toBe(1000);
  });

  it('flips to error when the exec rejects', async () => {
    const d = deferred<typeof RESULT>();
    const reg = new RestoreJobRegistry(() => d.promise);
    const job = reg.start(ARGS);
    d.reject(new Error('boom'));
    await tick();
    expect(reg.get(job.id)?.status).toBe('error');
    expect(reg.get(job.id)?.error).toContain('boom');
  });

  it('re-uses the in-flight job for the same Grove (double-click guard)', () => {
    const reg = new RestoreJobRegistry(() => new Promise(() => {}));
    const a = reg.start(ARGS);
    const b = reg.start(ARGS);
    expect(b.id).toBe(a.id);
    expect(reg.runningForGrove('g')?.id).toBe(a.id);
    expect(reg.runningForGrove('other')).toBeUndefined();
  });

  it('starts a fresh job once the previous one for a Grove finished', async () => {
    const d = deferred<typeof RESULT>();
    const reg = new RestoreJobRegistry(() => d.promise);
    const first = reg.start(ARGS);
    d.resolve(RESULT);
    await tick();
    const second = reg.start(ARGS);
    expect(second.id).not.toBe(first.id);
  });

  it('evicts finished jobs past the retention window so the map stays bounded', async () => {
    let clock = 1000;
    const reg = new RestoreJobRegistry(async () => RESULT, () => clock);
    const first = reg.start({ ...ARGS, groveId: 'g1' });
    await tick();
    expect(reg.get(first.id)?.status).toBe('done');

    // Advance past the 30-minute retention, then start another job.
    clock = 1000 + 31 * 60_000;
    reg.start({ ...ARGS, groveId: 'g2' });
    expect(reg.get(first.id)).toBeUndefined();
  });
});
