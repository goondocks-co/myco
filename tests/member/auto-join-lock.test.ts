/**
 * The platform pieces auto-join stands on (#1547), run on every platform CI has, Windows among them: a repository's
 * lock (a `LifecycleLock`) is held by one attempt whatever else races for it, and is let go of by the system the moment
 * the attempt holding it dies; and a hook's append and a join's move of held capture keep apart. The join itself runs
 * in the member helper's join bucket, started as every helper is (`tests/runtime/spawn-detached.test.ts`).
 */
import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeRepositoryLock } from '@myco/member/auto-join.js';
import { appendPending, flushPending } from '@myco/member/pending.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ensureMemberDir, memberRoot } from '@myco/member/store.js';

const KEY = 'a'.repeat(16);
const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-join-lock-'));

describe('a member directory', () => {
  it('is made when another process makes a level of it between the check and the mkdir', () => {
    const mycoHome = home();
    const dir = path.join(memberRoot(mycoHome), 'auto-join', 'left');
    const real = fs.existsSync;
    // Every level reads as absent, and each is already there by the time it is made: the first hooks of a new home racing.
    const absent = spyOn(fs, 'existsSync').mockImplementation((p) => (String(p).startsWith(memberRoot(mycoHome)) ? (fs.mkdirSync(String(p), { recursive: true }), false) : real(p)));
    try {
      ensureMemberDir(dir, mycoHome);
    } finally {
      absent.mockRestore();
    }
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

describe('a repository lock', () => {
  it('is held by one attempt at a time, and free again once released', () => {
    const mycoHome = home();
    const held = takeRepositoryLock(KEY, mycoHome);
    expect(held).not.toBeNull();
    expect(takeRepositoryLock(KEY, mycoHome)).toBeNull();
    held!.release();
    const again = takeRepositoryLock(KEY, mycoHome);
    expect(again).not.toBeNull();
    again!.release();
  });

  it('is let go of by the system the moment the attempt holding it dies, with no wait for it to go stale', async () => {
    const mycoHome = home();
    const script = path.join(mycoHome, 'hold.ts');
    const module = path.resolve('packages/myco/src/member/auto-join.ts');
    fs.writeFileSync(script, `import { takeRepositoryLock } from ${JSON.stringify(module)};\nif (takeRepositoryLock(${JSON.stringify(KEY)}, ${JSON.stringify(mycoHome)}) === null) process.exit(3);\nprocess.stdout.write('held');\nawait Bun.sleep(60_000);\n`);
    const holder = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' });
    await (holder.stdout as ReadableStream<Uint8Array>).getReader().read();
    expect(takeRepositoryLock(KEY, mycoHome)).toBeNull();
    holder.kill(9);
    await holder.exited;
    const taken = takeRepositoryLock(KEY, mycoHome);
    expect(taken).not.toBeNull();
    taken!.release();
  });

  it('goes to exactly one of many processes racing for it', async () => {
    const mycoHome = home();
    const script = path.join(mycoHome, 'race.ts');
    const module = path.resolve('packages/myco/src/member/auto-join.ts');
    // Each racer holds what it took for a while, so every other one meets it held.
    fs.writeFileSync(script, `import { takeRepositoryLock } from ${JSON.stringify(module)};\nconst lock = takeRepositoryLock(${JSON.stringify(KEY)}, ${JSON.stringify(mycoHome)});\nprocess.stdout.write(lock === null ? 'busy' : 'held');\nif (lock !== null) await Bun.sleep(3_000);\n`);
    const racers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' }));
    const answers = await Promise.all(racers.map(async (p) => { const text = await new Response(p.stdout).text(); await p.exited; return text; }));
    expect(answers.filter((a) => a === 'held')).toHaveLength(1);
    expect(answers.filter((a) => a === 'busy')).toHaveLength(5);
  }, 20_000);
});

describe('a repository\'s pending lock', () => {
  /** A process holding `rootKey`'s pending lock for `holdMs`, ready once it says so. */
  async function holdPendingLock(mycoHome: string, rootKey: string, holdMs: number): Promise<{ exited: Promise<number> }> {
    const script = path.join(mycoHome, 'hold.ts');
    const module = path.resolve('packages/myco/src/member/pending.ts');
    fs.writeFileSync(script, `import { withPendingLock } from ${JSON.stringify(module)};\nwithPendingLock(${JSON.stringify(rootKey)}, ${JSON.stringify(mycoHome)}, () => { process.stdout.write('held'); const until = Date.now() + ${holdMs}; while (Date.now() < until) { /* hold */ } });\n`);
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' });
    await (child.stdout as ReadableStream<Uint8Array>).getReader().read();
    return { exited: child.exited };
  }

  it('waits for a pending writer to append, then retries a busy migration after that writer leaves', async () => {
    const mycoHome = home();
    const rootKey = 'b'.repeat(16);
    const repo = { root: path.join(mycoHome, 'repo'), rootKey };
    const event = { envelope: { eventId: '00000000-0000-4000-8000-000000000001', sessionId: 's', kind: 'session.start', createdAt: 1, channel: 'cli', producer: { adapter: 'claude-code', version: '1' }, payload: {} } } as never;
    const appendHolder = await holdPendingLock(mycoHome, rootKey, 1_500);
    const appendStarted = Date.now();
    expect(appendPending(repo, 's', [event], undefined, { mycoHome, now: Date.now() })).toBe('pending');
    expect(Date.now() - appendStarted).toBeGreaterThanOrEqual(1_000);
    await appendHolder.exited;

    const target = new MemberSpool('proj_1', { mycoHome });
    const migrationHolder = await holdPendingLock(mycoHome, rootKey, 1_500);
    const migrationStarted = Date.now();
    expect(flushPending(rootKey, target, { mycoHome, now: Date.now() })).toBe(0);
    expect(Date.now() - migrationStarted).toBeLessThan(1_000);
    expect(target.readRecords('s')).toHaveLength(0);
    await migrationHolder.exited;
    expect(flushPending(rootKey, target, { mycoHome, now: Date.now() })).toBe(1);
    expect(target.readRecords('s')).toHaveLength(1);
  });
});
