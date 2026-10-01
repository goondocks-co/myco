/**
 * The two platform pieces auto-join stands on (#1547), run on every platform CI has, Windows among them: a repository's
 * lock is created exclusively, so one attempt holds it whatever else races for it, and is taken over once the attempt
 * that held it is gone; and a join started apart from a hook runs on after the hook's process is done with it.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireAutoJoinLock, AUTO_JOIN_LOCK_STALE_MS, autoJoinDir, releaseAutoJoinLock, spawnDetached } from '@myco/member/auto-join.js';
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
    const now = Date.now();
    const release = acquireAutoJoinLock(KEY, mycoHome, now);
    expect(release).not.toBeNull();
    expect(acquireAutoJoinLock(KEY, mycoHome, now)).toBeNull();
    release!();
    const again = acquireAutoJoinLock(KEY, mycoHome, now);
    expect(again).not.toBeNull();
    releaseAutoJoinLock(KEY, mycoHome);
    expect(fs.readdirSync(autoJoinDir(mycoHome)).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('is taken over once its holder is older than the stale bound, and not before', () => {
    const mycoHome = home();
    const now = Date.now();
    expect(acquireAutoJoinLock(KEY, mycoHome, now)).not.toBeNull();
    expect(acquireAutoJoinLock(KEY, mycoHome, now + AUTO_JOIN_LOCK_STALE_MS - 1_000)).toBeNull();
    expect(acquireAutoJoinLock(KEY, mycoHome, now + AUTO_JOIN_LOCK_STALE_MS + 1_000)).not.toBeNull();
  });

  it('goes to exactly one of many processes racing for it', async () => {
    const mycoHome = home();
    const script = path.join(mycoHome, 'race.ts');
    const module = path.resolve('packages/myco/src/member/auto-join.ts');
    fs.writeFileSync(script, `import { acquireAutoJoinLock } from ${JSON.stringify(module)};\nprocess.stdout.write(acquireAutoJoinLock(${JSON.stringify(KEY)}, ${JSON.stringify(mycoHome)}, Date.now()) === null ? 'busy' : 'held');\n`);
    const racers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' }));
    const answers = await Promise.all(racers.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect(answers.filter((a) => a === 'held')).toHaveLength(1);
    expect(answers.filter((a) => a === 'busy')).toHaveLength(5);
  });
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

  it('keeps a hook\'s append and the join\'s move apart: each waits while the other holds it', async () => {
    const mycoHome = home();
    const rootKey = 'b'.repeat(16);
    const repo = { root: path.join(mycoHome, 'repo'), rootKey };
    const event = { envelope: { eventId: '00000000-0000-4000-8000-000000000001', sessionId: 's', kind: 'session.start', createdAt: 1, channel: 'cli', producer: { adapter: 'claude-code', version: '1' }, payload: {} } } as never;
    for (const act of [
      () => appendPending(repo, 's', [event], undefined, { mycoHome, now: Date.now() }),
      () => flushPending(rootKey, new MemberSpool('proj_1', { mycoHome }), { mycoHome, now: Date.now() }),
    ]) {
      const holder = await holdPendingLock(mycoHome, rootKey, 1_500);
      const started = Date.now();
      act();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
      await holder.exited;
    }
  });
});

describe('a detached start', () => {
  it('runs the command on its own, with the environment it is handed, and reports that it started', async () => {
    const dir = home();
    const out = path.join(dir, 'ran.txt');
    const script = path.join(dir, 'child.ts');
    fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(out)}, process.env.MYCO_HOME ?? '');\n`);
    expect(spawnDetached(process.execPath, [script], { cwd: dir, env: { ...process.env, MYCO_HOME: dir } })).toBe(true);
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(out) || fs.readFileSync(out, 'utf-8') === '') {
      if (Date.now() > deadline) throw new Error('the detached child never ran');
      await Bun.sleep(50);
    }
    expect(fs.readFileSync(out, 'utf-8')).toBe(dir);
  });

  // Windows has no process group a harness kills a hook through; there, a detached child's own console is what keeps it.
  it.skipIf(process.platform === 'win32')('keeps running when the harness kills the hook\'s whole process group', async () => {
    const dir = home();
    const out = path.join(dir, 'survived.txt');
    const child = path.join(dir, 'child.ts');
    fs.writeFileSync(child, `await Bun.sleep(1500);\nrequire('node:fs').writeFileSync(${JSON.stringify(out)}, 'alive');\n`);
    const hook = path.join(dir, 'hook.ts');
    const module = path.resolve('packages/myco/src/member/auto-join.ts');
    fs.writeFileSync(hook, `import { spawnDetached } from ${JSON.stringify(module)};\nspawnDetached(process.execPath, [${JSON.stringify(child)}], { cwd: ${JSON.stringify(dir)}, env: process.env });\nprocess.stdout.write('started');\nawait Bun.sleep(60_000);\n`);
    // The hook runs in a process group of its own, as a harness starts it; the kill takes the whole group.
    const started = Bun.spawn([process.execPath, hook], { stdout: 'pipe', stderr: 'ignore', detached: true } as never);
    const reader = (started.stdout as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    process.kill(-started.pid, 'SIGKILL');
    await started.exited;
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(out)) {
      if (Date.now() > deadline) throw new Error('the detached child died with the hook\'s process group');
      await Bun.sleep(100);
    }
    expect(fs.readFileSync(out, 'utf-8')).toBe('alive');
  });

  it('reports a command that cannot start as not started, without throwing', () => {
    const dir = home();
    expect(spawnDetached(path.join(dir, 'no-such-binary'), [], { cwd: dir, env: process.env })).toBe(false);
  });
});
