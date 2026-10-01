/**
 * The member helper: one helper per project at a time, under a lock the operating system releases when it dies;
 * passes until nothing new arrives for a short linger; never past its deadline. No kick is lost: not one that lands as
 * the helper lets go, nor one during its last pass before the deadline, nor one during a pass that fails. A turn's or
 * a session's end dials past the offline latch; any other kick waits for it. A kick the helper cannot outlive is
 * logged and answered so its caller ships inline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { helperPass, runHelperVerb } from '@myco/cli/member-helper.js';
import { helperLogPath, helperPaths, kickHelper, runHelper, shipsInline, type KickOutcome } from '@myco/member/helper.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import type { DetachedSpawn } from '@myco/runtime/spawn-detached.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

const PROJECT = 'proj_1';
let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
});
afterEach(() => { process.env.MYCO_HOME = savedHome; });

/** A clock the helper's own sleeps advance, so a linger or a deadline costs no wall time. */
function fakeTime(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

describe('the member helper', () => {
  it('runs one pass, lingers, and exits idle when nothing new arrives', async () => {
    const clock = fakeTime();
    let passes = 0;
    const result = await runHelper({ projectId: PROJECT, mycoHome, ...clock, pass: async () => { passes += 1; } });
    expect(result).toEqual({ endedBy: 'idle', passes: 1 });
    // It let go of the lock: the next helper takes it.
    const lock = LifecycleLock.acquire(helperPaths(PROJECT, mycoHome).lock);
    expect(lock.acquired).toBe(true);
    if (lock.acquired) lock.lock.release();
  });

  it('runs another pass for work that arrives while a pass runs, and for work that arrives while it lingers', async () => {
    const clock = fakeTime();
    const { dirty } = helperPaths(PROJECT, mycoHome);
    let passes = 0;
    const result = await runHelper({
      projectId: PROJECT, mycoHome, now: clock.now,
      // The second sleep of the linger finds a kick's mark.
      sleep: async (ms) => { clock.advance(ms); if (passes === 2 && clock.now() % 1_000 === 400) fs.writeFileSync(dirty, ''); },
      pass: async () => { passes += 1; if (passes === 1) fs.writeFileSync(dirty, ''); },
    });
    expect(result).toEqual({ endedBy: 'idle', passes: 3 });
    expect(fs.existsSync(dirty)).toBe(false);
  });

  it('loses no kick that lands as it lets go of the lock', async () => {
    const clock = fakeTime();
    const { dirty } = helperPaths(PROJECT, mycoHome);
    let releases = 0;
    let passes = 0;
    const result = await runHelper({
      projectId: PROJECT, mycoHome, ...clock,
      pass: async () => { passes += 1; },
      // A hook's kick between the helper's last look and its exit: it found the lock held, so it left only its mark.
      onReleased: () => { releases += 1; if (releases === 1) fs.writeFileSync(dirty, ''); },
    });
    expect(result).toEqual({ endedBy: 'idle', passes: 2 });
  });

  it('stops at its deadline however much work keeps arriving', async () => {
    const clock = fakeTime();
    const { dirty } = helperPaths(PROJECT, mycoHome);
    const result = await runHelper({
      projectId: PROJECT, mycoHome, ...clock, deadlineMs: 10_000,
      pass: async () => { clock.advance(1_000); fs.writeFileSync(dirty, ''); },
    });
    expect(result.endedBy).toBe('deadline');
    expect(result.passes).toBe(10);
  });

  it('does nothing while another helper holds the lock', async () => {
    const held = LifecycleLock.acquire(helperPaths(PROJECT, mycoHome).lock);
    expect(held.acquired).toBe(true);
    try {
      let passes = 0;
      const result = await runHelper({ projectId: PROJECT, mycoHome, ...fakeTime(), pass: async () => { passes += 1; } });
      expect(result).toEqual({ endedBy: 'busy', passes: 0 });
    } finally {
      if (held.acquired) held.lock.release();
    }
  });
});

describe('a kick', () => {
  it('marks the work and starts a helper when none runs, carrying the project and the home on its command line', () => {
    const starts: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const spawn: DetachedSpawn = (command, args, opts) => { starts.push({ command, args, cwd: opts.cwd }); return { started: true }; };
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn })).toEqual({ kind: 'started', contained: false });
    expect(fs.existsSync(helperPaths(PROJECT, mycoHome).dirty)).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0].args.slice(-6)).toEqual(['member', 'helper', '--project', PROJECT, '--home', mycoHome]);
  });

  it('only marks the work when a helper already runs, which reads the mark before it exits', () => {
    const held = LifecycleLock.acquire(helperPaths(PROJECT, mycoHome).lock);
    try {
      let started = 0;
      const spawn: DetachedSpawn = () => { started += 1; return { started: true }; };
      expect(kickHelper({ projectId: PROJECT, mycoHome, spawn })).toEqual({ kind: 'running' });
      expect(started).toBe(0);
      expect(fs.existsSync(helperPaths(PROJECT, mycoHome).dirty)).toBe(true);
    } finally {
      if (held.acquired) held.lock.release();
    }
  });

  it('says so when a helper could not be started', () => {
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn: () => ({ started: false }) })).toEqual({ kind: 'failed' });
  });
});

describe('myco member helper', () => {
  it('ships the project\'s spool to its Deployment and logs what it did', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'sess-helper', stage: spool.stagerFor('sess-helper'), version: 't' };
    for (const text of ['one', 'two', 'three']) spool.append('sess-helper', promptEvent(ctx, { promptId: mintId(), text }));

    const result = await runHelperVerb(['--project', PROJECT, '--home', mycoHome], { fetch: rig.fetch, lingerMs: 0 });
    expect(result).toEqual({ endedBy: 'idle', passes: 1 });
    expect(rig.rows('events')).toBe(3);
    expect(fs.existsSync(path.join(spool.dir, 'sess-helper.jsonl'))).toBe(false);
    const log = fs.readFileSync(helperLogPath(mycoHome), 'utf-8');
    expect(log).toContain(`${PROJECT} [myco] helper: pass over 1 session(s), 3 record(s) and segment(s) delivered`);
  });

  it('refuses a command line naming no project or no home', async () => {
    const saved = process.exitCode;
    const err = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: () => boolean }).write = () => true;
    try {
      expect(await runHelperVerb(['--project', PROJECT])).toBeNull();
      expect(process.exitCode).toBe(2);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = err;
      // Bun keeps a non-zero exit code assigned `undefined`; only 0 clears it.
      process.exitCode = saved ?? 0;
    }
  });
});

/** A detached start that runs the helper verb in this process, as the started process would; its runs are collected. */
function inProcessHelpers(deps: Parameters<typeof runHelperVerb>[1]) {
  const runs: Array<Promise<unknown>> = [];
  const starts: string[][] = [];
  const spawn: DetachedSpawn = (_command, args) => {
    const verb = args.slice(args.indexOf('helper') + 1);
    starts.push(verb);
    runs.push(runHelperVerb(verb, { ...deps, spawn }).catch((err: unknown) => err));
    return { started: true, pid: process.pid };
  };
  const settle = async () => { for (let done = 0; done < runs.length; done = runs.length) await Promise.all(runs.slice(done)); };
  return { spawn, starts, settle };
}

describe('no kick is lost on the way out', () => {
  it('starts a successor at the deadline for a kick that landed during the last pass, which delivers it', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'sess-late', stage: spool.stagerFor('sess-late'), version: 't' };
    spool.append('sess-late', promptEvent(ctx, { promptId: mintId(), text: 'before' }));
    const clock = fakeTime(Date.now());
    const deps = { fetch: rig.fetch, keepStderr: true, lingerMs: 0, deadlineMs: 10_000, now: clock.now, sleep: clock.sleep };
    const successors = inProcessHelpers(deps);
    let passes = 0;
    const realPass = helperPass(PROJECT, mycoHome, { fetch: rig.fetch, now: clock.now });
    const first = await runHelperVerb(['--project', PROJECT, '--home', mycoHome], {
      ...deps,
      spawn: successors.spawn,
      pass: async (deadline, opts) => {
        const result = await realPass(deadline, opts);
        passes += 1;
        // The Stop hook of a busy turn: it appends and kicks while the helper holds the lock, then the pass runs out the clock.
        spool.append('sess-late', promptEvent(ctx, { promptId: mintId(), text: 'the turn\'s last words' }));
        expect(kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => { throw new Error('a running helper is not started again'); } })).toEqual({ kind: 'running' });
        clock.advance(20_000);
        return result;
      },
    });
    expect(first).toEqual({ endedBy: 'deadline', passes: 1, successor: 'started' });
    await successors.settle();
    expect(successors.starts).toHaveLength(1);
    expect(rig.rows('events')).toBe(2);
    expect(fs.existsSync(path.join(spool.dir, 'sess-late.jsonl'))).toBe(false);
    expect(passes).toBe(1);
  });

  it('logs a pass that fails, puts its marks back, and starts a successor that delivers the work', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'sess-fail', stage: spool.stagerFor('sess-fail'), version: 't' };
    spool.append('sess-fail', promptEvent(ctx, { promptId: mintId(), text: 'kept' }));
    // A turn's end asked for a probe past the latch: the failed pass must not spend it.
    kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => ({ started: false }) });
    const forces: boolean[] = [];
    const realPass = helperPass(PROJECT, mycoHome, { fetch: rig.fetch });
    const successors = inProcessHelpers({ fetch: rig.fetch, lingerMs: 0, keepStderr: true, pass: async (deadline, opts) => { forces.push(opts.force); return realPass(deadline, opts); } });
    const failed = runHelperVerb(['--project', PROJECT, '--home', mycoHome], {
      fetch: rig.fetch, lingerMs: 0, spawn: successors.spawn,
      pass: async () => { throw new Error('the disk went away'); },
    });
    await expect(failed).rejects.toThrow('the disk went away');
    const log = fs.readFileSync(helperLogPath(mycoHome), 'utf-8');
    expect(log).toContain(`${PROJECT} [myco] helper: a pass failed: the disk went away`);
    expect(log).toContain('by a failed pass; a successor takes its work');
    expect(successors.starts).toEqual([['--project', PROJECT, '--home', mycoHome, '--after-failure']]);
    await successors.settle();
    expect(rig.rows('events')).toBe(1);
    // The probe the turn's end asked for went to the successor's pass, not to the pass that failed.
    expect(forces).toEqual([true]);
    expect(fs.existsSync(helperPaths(PROJECT, mycoHome).probe)).toBe(false);
  });

  it('starts a successor at the deadline for work its last pass had no time for, though no kick came', async () => {
    const clock = fakeTime();
    const starts: string[][] = [];
    const result = await runHelper({
      projectId: PROJECT, mycoHome, ...clock, deadlineMs: 10_000,
      spawn: (_command, args) => { starts.push([...args]); return { started: true, pid: process.pid }; },
      pass: async () => { clock.advance(11_000); return { more: true }; },
    });
    expect(result).toEqual({ endedBy: 'deadline', passes: 1, successor: 'started' });
    expect(starts).toHaveLength(1);
    // A pass that finished leaves no successor behind it.
    const done = await runHelper({ projectId: PROJECT, mycoHome, ...fakeTime(), deadlineMs: 10_000, pass: async () => ({ more: false }) });
    expect(done).toEqual({ endedBy: 'idle', passes: 1 });
  });

  it('leaves the marks for the next kick when the successor of a failure fails too, and starts nobody', async () => {
    let started = 0;
    const err = await runHelper({
      projectId: PROJECT, mycoHome, ...fakeTime(), afterFailure: true,
      spawn: () => { started += 1; return { started: true }; },
      pass: async () => { throw new Error('still broken'); },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain('still broken');
    expect(started).toBe(0);
    expect(fs.existsSync(helperPaths(PROJECT, mycoHome).dirty)).toBe(true);
    // The lock is free for the next kick's helper.
    const lock = LifecycleLock.acquire(helperPaths(PROJECT, mycoHome).lock);
    expect(lock.acquired).toBe(true);
    if (lock.acquired) lock.lock.release();
  });
});

describe('the offline latch', () => {
  it('holds an ordinary kick\'s pass back, and lets a turn\'s or a session\'s end dial past it', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'sess-latch', stage: spool.stagerFor('sess-latch'), version: 't' };
    spool.append('sess-latch', promptEvent(ctx, { promptId: mintId(), text: 'while offline' }));
    spool.markOffline(Date.now());
    const noSpawn: DetachedSpawn = () => ({ started: true });
    const helper = () => runHelperVerb(['--project', PROJECT, '--home', mycoHome], { fetch: rig.fetch, lingerMs: 0, keepStderr: true });

    kickHelper({ projectId: PROJECT, mycoHome, reason: 'capture', spawn: noSpawn });
    await helper();
    expect(rig.rows('events')).toBe(0);
    for (const reason of ['turn-end', 'session-end'] as const) {
      kickHelper({ projectId: PROJECT, mycoHome, reason, spawn: noSpawn });
      expect(fs.existsSync(helperPaths(PROJECT, mycoHome).probe)).toBe(true);
    }
    await helper();
    expect(rig.rows('events')).toBe(1);
    expect(spool.readLatch()).toBeNull();
  });
});

describe('a kick whose helper cannot outlive it', () => {
  it('is logged and answered so the caller ships inline: a start refused, or one held in the caller\'s Job Object', () => {
    const outcomes: KickOutcome[] = [
      kickHelper({ projectId: PROJECT, mycoHome, spawn: () => ({ started: false }) }),
      kickHelper({ projectId: PROJECT, mycoHome, spawn: () => ({ started: true, pid: process.pid, contained: true }) }),
    ];
    expect(outcomes).toEqual([{ kind: 'failed' }, { kind: 'started', contained: true }]);
    expect(outcomes.map(shipsInline)).toEqual([true, true]);
    expect([{ kind: 'running' }, { kind: 'starting' }, { kind: 'started', contained: false }].map((o) => shipsInline(o as KickOutcome))).toEqual([false, false, false]);
    const log = fs.readFileSync(helperLogPath(mycoHome), 'utf-8');
    expect(log).toContain(`${PROJECT} [myco] helper: kick (capture) could not start a helper; the caller ships inline`);
    expect(log).toContain(`${PROJECT} [myco] helper: kick (capture) started a helper inside the caller's Job Object`);
  });
});

describe('a start under way', () => {
  it('spares every kick that lands before its helper takes the lock a start of its own, until its process is gone', () => {
    let started = 0;
    const spawn: DetachedSpawn = () => { started += 1; return { started: true, pid: process.pid }; };
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    for (let i = 0; i < 20; i++) expect(kickHelper({ projectId: PROJECT, mycoHome, spawn })).toEqual({ kind: 'starting' });
    expect(started).toBe(1);
    // A started process that died before it took the lock: its claim is spent, and the next kick starts another.
    const dead = Bun.spawnSync([process.execPath, '-e', '0']).pid;
    fs.writeFileSync(helperPaths(PROJECT, mycoHome).starting, JSON.stringify({ at: Date.now(), pid: dead }));
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    expect(started).toBe(2);
  });

  it('is over once its helper takes the lock: a kick after that helper has gone starts the next', async () => {
    const runs: Array<Promise<unknown>> = [];
    const spawn: DetachedSpawn = () => {
      runs.push(runHelper({ projectId: PROJECT, mycoHome, ...fakeTime(), pass: async () => {} }));
      return { started: true, pid: process.pid };
    };
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    await Promise.all(runs);
    expect(fs.existsSync(helperPaths(PROJECT, mycoHome).starting)).toBe(false);
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    await Promise.all(runs);
  });
});
