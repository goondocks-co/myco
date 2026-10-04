/**
 * The member helper: one helper per project at a time, under a lock the operating system releases when it dies;
 * passes until nothing new arrives for a short linger; never past its deadline. No kick is lost: not one that lands as
 * the helper lets go, nor one during its last pass before the deadline, nor one during a pass that fails. A turn's or
 * a session's end dials past the offline latch; any other kick waits for it. A kick the helper cannot outlive is
 * logged and answered so its caller ships inline.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { helperPass, runHelperVerb } from '@myco/cli/member-helper.js';
import { HELPER_START_GRACE_MS, helperLogPath, helperPaths, kickHelper, runHelper, shipsInline, type KickOutcome } from '@myco/member/helper.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { machineSettingsPath } from '@myco/member/registry.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import type { DetachedSpawn } from '@myco/runtime/spawn-detached.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { SWEEP_INTERVAL_MS } from '@myco/member/sweep.js';
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
      expect(kickHelper({ projectId: PROJECT, mycoHome, spawn })).toEqual({ kind: 'running', contained: false });
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
  for (const damage of ['loose-mode', 'truncated', 'foreign-owner', 'unreadable', 'directory'] as const) {
    it(`delivers capture with ${damage} machine-settings order file`, async () => {
      const rig = await memberRig();
      registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
      const spool = new MemberSpool(PROJECT, { mycoHome });
      const sessionId = `sess-order-${damage}`;
      const ctx = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: 't' };
      spool.append(sessionId, promptEvent(ctx, { promptId: mintId(), text: 'must arrive' }));
      updateSessionState(spool.dir, sessionId, (state) => { state.contextAsks = [{ kind: 'start', at: Date.now() }]; });
      const orderFile = `${machineSettingsPath('https://s', mycoHome)}.order`;
      fs.mkdirSync(path.dirname(orderFile), { recursive: true, mode: 0o700 });
      if (damage === 'directory') fs.mkdirSync(orderFile, { mode: 0o700 });
      else fs.writeFileSync(orderFile, damage === 'truncated' ? '{"issued":' : '{"issued":999,"received":999}\n', { mode: damage === 'loose-mode' ? 0o644 : 0o600 });
      const realLstat = fs.lstatSync;
      const ownerStat = damage === 'foreign-owner' ? spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
        const result = Reflect.apply(realLstat, fs, [file, ...args]) as fs.Stats;
        return String(file) === orderFile ? Object.assign(Object.create(Object.getPrototypeOf(result)), result, { uid: result.uid + 1 }) : result;
      }) as typeof fs.lstatSync) : null;
      const realStat = fs.statSync;
      const unreadableStat = damage === 'unreadable' ? spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
        if (String(file) === orderFile) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return Reflect.apply(realStat, fs, [file, ...args]);
      }) as typeof fs.statSync) : null;
      const diagnostics: string[] = [];
      const write = damage === 'foreign-owner' ? spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
        diagnostics.push(String(chunk));
        return true;
      }) as typeof process.stderr.write) : null;
      try {
        await helperPass(PROJECT, mycoHome, { fetch: rig.fetch })(Date.now() + 15_000, { force: true });
      } finally { ownerStat?.mockRestore(); unreadableStat?.mockRestore(); write?.mockRestore(); }
      expect(rig.rows('events')).toBe(1);
      expect(spool.depth(sessionId)).toBe(0);
      if (damage === 'foreign-owner' && typeof process.getuid === 'function') expect(diagnostics.join('')).toContain('foreign-owner');
      if (damage === 'directory') expect(fs.statSync(orderFile).isDirectory()).toBe(true);
      else {
        expect(JSON.parse(fs.readFileSync(orderFile, 'utf-8')).issued).toBeGreaterThan(999);
        if (process.platform !== 'win32') expect(fs.statSync(orderFile).mode & 0o777).toBe(0o600);
      }
    });
  }

  it('drains the backlog when optional prefetch throws', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const sessionId = 'sess-prefetch-fails';
    const ctx = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: 't' };
    spool.append(sessionId, promptEvent(ctx, { promptId: mintId(), text: 'must arrive' }));
    updateSessionState(spool.dir, sessionId, (state) => { state.contextAsks = [{ kind: 'start', at: Date.now() }]; });
    const orderFile = `${machineSettingsPath('https://s', mycoHome)}.order`;
    const realRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === orderFile || String(to) === `${orderFile}-checkpoint`) throw new Error('optional order write failed');
      return realRename(from, to);
    });
    const diagnostics: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      diagnostics.push(String(chunk));
      return realWrite(chunk);
    }) as typeof process.stderr.write);
    try {
      await helperPass(PROJECT, mycoHome, { fetch: rig.fetch })(Date.now() + 15_000, { force: true });
    } finally { rename.mockRestore(); write.mockRestore(); }
    expect(rig.rows('events')).toBe(1);
    expect(spool.depth(sessionId)).toBe(0);
    expect(diagnostics.join('')).toContain('context prefetch failed: Cannot persist machine settings request order.');
  });

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
  const settle = async () => {
    for (let done = 0; done < runs.length;) {
      const until = runs.length;
      await Promise.all(runs.slice(done, until));
      done = until;
    }
  };
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
        expect(kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => { throw new Error('a running helper is not started again'); } })).toEqual({ kind: 'running', contained: false });
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

  it('hands a forced pass\'s probe on when the pass runs out of time, so its successor is forced too', async () => {
    const clock = fakeTime();
    const paths = helperPaths(PROJECT, mycoHome);
    kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => ({ started: false }) });
    const forces: boolean[] = [];
    await runHelper({
      projectId: PROJECT, mycoHome, ...clock, deadlineMs: 10_000,
      spawn: () => ({ started: true, pid: process.pid }),
      pass: async (_deadline, opts) => { forces.push(opts.force); clock.advance(11_000); return { more: true }; },
    });
    expect(forces).toEqual([true]);
    expect(fs.existsSync(paths.probe)).toBe(true);
    // The successor's pass is forced.
    try { fs.unlinkSync(paths.starting); } catch { /* none */ }
    await runHelper({ projectId: PROJECT, mycoHome, ...fakeTime(), pass: async (_d, opts) => { forces.push(opts.force); } });
    expect(forces).toEqual([true, true]);
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

  it('takes the lock again for a kick that found its start claim while another held the lock', async () => {
    const paths = helperPaths(PROJECT, mycoHome);
    // A kick's probe holds the lock as this helper starts, and the helper's own start claim is still there.
    fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
    fs.writeFileSync(paths.starting, JSON.stringify({ at: Date.now(), pid: process.pid }));
    const probe = LifecycleLock.acquire(paths.lock);
    expect(probe.acquired).toBe(true);
    let kicked: KickOutcome | null = null;
    let passes = 0;
    const result = await runHelper({
      projectId: PROJECT, mycoHome, ...fakeTime(),
      pass: async () => { passes += 1; },
      // Between this helper's failed take and its claim's removal: the probe lets go, finds the claim, and the kick
      // leaves only its mark.
      onBusy: () => {
        if (probe.acquired) probe.lock.release();
        kicked = kickHelper({ projectId: PROJECT, mycoHome, reason: 'session-end', spawn: () => { throw new Error('a start under way is not started again'); } });
      },
    });
    expect(kicked as KickOutcome | null).toEqual({ kind: 'starting', contained: false });
    expect(result).toEqual({ endedBy: 'idle', passes: 1 });
    expect(passes).toBe(1);
    expect(fs.existsSync(paths.dirty)).toBe(false);
  });

  it('logs a successor it could not start as work left for the next kick, not as the caller shipping inline', async () => {
    await runHelper({
      projectId: PROJECT, mycoHome, ...fakeTime(),
      spawn: () => ({ started: false }),
      pass: async () => { throw new Error('broken'); },
    }).catch(() => {});
    const log = fs.readFileSync(helperLogPath(mycoHome), 'utf-8');
    expect(log).toContain('[myco] helper: a failed pass could not start a helper; the work waits for the next kick');
    expect(log).not.toContain('ships inline');
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

describe('a forced pass', () => {
  it('dials past the latch, and still leaves a record inside its refusal wait alone', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: 'https://s' });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'sess-wait', stage: spool.stagerFor('sess-wait'), version: 't' };
    spool.append('sess-wait', promptEvent(ctx, { promptId: mintId(), text: 'held for now' }));
    // A refusal set a wait that has not run out; the spool is also latched offline.
    updateSessionState(spool.dir, 'sess-wait', (s) => { s.eventRetry = { at: Date.now() + 60_000, backoffMs: 60_000 }; });
    spool.markOffline(Date.now());
    kickHelper({ projectId: PROJECT, mycoHome, reason: 'session-end', spawn: () => ({ started: true }) });
    await runHelperVerb(['--project', PROJECT, '--home', mycoHome], { fetch: rig.fetch, lingerMs: 0, keepStderr: true });
    expect(rig.rows('events')).toBe(0);
    expect(spool.depth('sess-wait')).toBe(1);
    // Once the wait is out, the next forced pass sends it.
    updateSessionState(spool.dir, 'sess-wait', (s) => { s.eventRetry = { at: Date.now() - 1, backoffMs: 60_000 }; });
    kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => ({ started: true }) });
    await runHelperVerb(['--project', PROJECT, '--home', mycoHome], { fetch: rig.fetch, lingerMs: 0, keepStderr: true });
    expect(rig.rows('events')).toBe(1);
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
    expect(([
      { kind: 'running', contained: false }, { kind: 'starting', contained: false }, { kind: 'started', contained: false },
    ] as KickOutcome[]).map(shipsInline)).toEqual([false, false, false]);
    const log = fs.readFileSync(helperLogPath(mycoHome), 'utf-8');
    expect(log).toContain(`${PROJECT} [myco] helper: kick (capture) could not start a helper; the caller ships inline`);
    expect(log).toContain(`${PROJECT} [myco] helper: kick (capture) started a helper inside the caller's Job Object`);
  });
});

describe('a helper that ends with the harness, found by a later kick', () => {
  it('is answered contained while on its way, and while it holds the lock: the later kick ships inline too', async () => {
    // A capture hook's kick started it inside the harness's Job Object.
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn: () => ({ started: true, pid: process.pid, contained: true }) }))
      .toEqual({ kind: 'started', contained: true });
    const onItsWay = kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => { throw new Error('a start under way is not started again'); } });
    expect(onItsWay).toEqual({ kind: 'starting', contained: true });
    expect(shipsInline(onItsWay)).toBe(true);

    // The helper takes the lock: its own start claim says it is contained, and the lock says so to every kick after.
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let found: KickOutcome | null = null;
    const run = runHelper({
      projectId: PROJECT, mycoHome, contained: false, lingerMs: 0,
      pass: async () => {
        // The first pass only: the kick's mark asks for one more, which finds nothing to do.
        if (found !== null) return;
        found = kickHelper({ projectId: PROJECT, mycoHome, reason: 'turn-end', spawn: () => { throw new Error('a running helper is not started again'); } });
        await holding;
      },
    });
    while (found === null) await Bun.sleep(5);
    expect(found as KickOutcome | null).toEqual({ kind: 'running', contained: true });
    release();
    await run;
    // A helper free of any job leaves a lock that says nothing of one.
    let seen = false;
    await runHelper({
      projectId: PROJECT, mycoHome, contained: false, lingerMs: 0,
      pass: async () => {
        if (seen) return;
        seen = true;
        found = kickHelper({ projectId: PROJECT, mycoHome, spawn: () => ({ started: false }) });
      },
    });
    expect(found as KickOutcome | null).toEqual({ kind: 'running', contained: false });
  });
});

describe('the sweep a helper ends with', () => {
  it('kicks every other project holding undelivered work, once a sweep interval, and none with nothing waiting or latched offline', async () => {
    const rig = await memberRig();
    const roots = ['a', 'b', 'c', 'd'].map((name) => fs.mkdtempSync(path.join(mycoHome, `root-${name}-`)));
    for (const [i, projectId] of ['proj_1', 'proj_2', 'proj_3', 'proj_4'].entries()) {
      registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId, expiresAt: rig.expiresAt, serverUrl: 'https://s', root: roots[i] });
    }
    // proj_2's last turn never reached the Deployment; proj_3 holds nothing.
    const waiting = new MemberSpool('proj_2', { mycoHome });
    waiting.append('sess-left', promptEvent({ agent: 'claude-code', sessionId: 'sess-left', stage: waiting.stagerFor('sess-left') }, { promptId: mintId(), text: 'the last turn' }));
    fs.mkdirSync(new MemberSpool('proj_3', { mycoHome }).dir, { recursive: true });
    const starts: string[][] = [];
    // proj_4 holds work too, but its Deployment is latched offline for the next hour: its own probe decides when it dials.
    const latched = new MemberSpool('proj_4', { mycoHome });
    latched.append('sess-latched', promptEvent({ agent: 'claude-code', sessionId: 'sess-latched', stage: latched.stagerFor('sess-latched') }, { promptId: mintId(), text: 'offline' }));
    const spawn: DetachedSpawn = (_command, args) => { starts.push([...args]); return { started: false }; };
    const clock = fakeTime(Date.now());
    latched.markOffline(clock.now(), 3_600_000);
    const helperOf = () => runHelperVerb(['--project', 'proj_1', '--home', mycoHome], { keepStderr: true, now: clock.now, sleep: clock.sleep, lingerMs: 0, spawn, pass: async () => {} });

    await helperOf();
    expect(starts.map((args) => args[args.indexOf('--project') + 1])).toEqual(['proj_2']);
    // The next hook moments later starts no second helper for it; one past the interval does.
    await helperOf();
    expect(starts).toHaveLength(1);
    clock.advance(SWEEP_INTERVAL_MS + 1);
    await helperOf();
    expect(starts.map((args) => args[args.indexOf('--project') + 1])).toEqual(['proj_2', 'proj_2']);
  });
});

describe('a start under way', () => {
  it('spares every kick that lands before its helper takes the lock a start of its own, until its process is gone', () => {
    let started = 0;
    const spawn: DetachedSpawn = () => { started += 1; return { started: true, pid: process.pid }; };
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    for (let i = 0; i < 20; i++) expect(kickHelper({ projectId: PROJECT, mycoHome, spawn })).toEqual({ kind: 'starting', contained: false });
    expect(started).toBe(1);
    // A started process that died before it took the lock: its claim is spent, and the next kick starts another.
    const dead = Bun.spawnSync([process.execPath, '-e', '0']).pid;
    fs.writeFileSync(helperPaths(PROJECT, mycoHome).starting, JSON.stringify({ at: Date.now(), pid: dead }));
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    expect(started).toBe(2);
  });

  it('is spent past its grace even with a live process, and when dated after now, so neither a hung start nor a clock set back holds kicks off', () => {
    let started = 0;
    const spawn: DetachedSpawn = () => { started += 1; return { started: true, pid: process.pid }; };
    const { starting } = helperPaths(PROJECT, mycoHome);
    fs.mkdirSync(path.dirname(starting), { recursive: true });
    const claims = [
      // A live process (this one: a reused pid, or a start that hung) claimed past the grace.
      { at: Date.now() - HELPER_START_GRACE_MS - 1_000, pid: process.pid },
      // Claimed and not yet given a process, dated in the future.
      { at: Date.now() + 3_600_000 },
      // Given a live process, dated in the future.
      { at: Date.now() + 3_600_000, pid: process.pid },
    ];
    for (const claim of claims) {
      fs.writeFileSync(starting, JSON.stringify(claim));
      expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    }
    // A claim not yet written, its file dated in the future.
    fs.writeFileSync(starting, '');
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(starting, future, future);
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    expect(started).toBe(4);
  });

  it('answers a start that threw as one that failed, and leaves no claim to hold the next kick off', () => {
    const outcome = kickHelper({ projectId: PROJECT, mycoHome, spawn: () => { throw new Error('spawn exploded'); } });
    expect(outcome).toEqual({ kind: 'failed' });
    expect(fs.existsSync(helperPaths(PROJECT, mycoHome).starting)).toBe(false);
    let started = 0;
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn: () => { started += 1; return { started: true, pid: process.pid }; } }).kind).toBe('started');
    expect(started).toBe(1);
  });

  it('starts a helper when a spent claim cannot be cleared, rather than wait on a start that is not coming', () => {
    let started = 0;
    const spawn: DetachedSpawn = () => { started += 1; return { started: true, pid: process.pid }; };
    const { starting } = helperPaths(PROJECT, mycoHome);
    // Something that is not a claim stands at its path, old, and no unlink removes it.
    fs.mkdirSync(starting, { recursive: true });
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(starting, old, old);
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn }).kind).toBe('started');
    expect(started).toBe(1);
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
