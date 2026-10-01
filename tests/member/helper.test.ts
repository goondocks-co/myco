/**
 * The member helper (#1561 PR 3a): one helper per project at a time, under a lock the operating system releases when
 * it dies; passes until nothing new arrives for a short linger; no kick lost, including one that lands as the helper
 * lets go; never past its deadline. Nothing calls the helper yet: hooks kick it from PR 3b.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { helperLogPath, helperPaths, kickHelper, runHelper } from '@myco/member/helper.js';
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
    expect(kickHelper({ projectId: PROJECT, mycoHome, spawn })).toEqual({ kind: 'started', started: true });
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
