/**
 * The settle a worker waits out after its machine wakes (#1424), and what keeps
 * the machine awake while it drives a run.
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { SUSPEND_SLACK_MS, WAKE_SETTLE_MAX_MS, WAKE_SETTLE_MS, watchWake } from '@myco/runner/wake.js';
import { CAFFEINATE, keepAwakeWith, keepMachineAwake, type KeepAwakeDeps } from '@myco/runner/keep-awake.js';
import { attachOptions } from '@myco/cli/worker.js';

/** A wall clock a test moves by hand. */
function wallClock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => now, pass: (ms: number) => { now += ms; } };
}

describe('the settle after a wake', () => {
  it('claims at once in a process that has seen no sleep', () => {
    const c = wallClock();
    expect(watchWake(c.now).settled()).toBe(true);
  });

  it('claims nothing in the longest dark wake observed, and only after the base settle', () => {
    const c = wallClock();
    const wake = watchWake(c.now);
    // A 2 s wait that the wall clock says lasted twenty minutes: the machine slept.
    const waited = wake.begin(2_000);
    c.pass(20 * 60_000);
    expect(waited()).toBe(true);
    c.pass(122_000);
    expect({ settled: wake.settled(), settleMs: wake.settleMs() }).toEqual({ settled: false, settleMs: WAKE_SETTLE_MS });
    expect(WAKE_SETTLE_MS).toBeGreaterThanOrEqual(122_000 * 1.25);
    c.pass(WAKE_SETTLE_MS - 122_000);
    expect(wake.settled()).toBe(true);
  });

  it('does not read a slow wait as a sleep', () => {
    const c = wallClock();
    const wake = watchWake(c.now);
    const waited = wake.begin(2_000);
    c.pass(2_000 + SUSPEND_SLACK_MS);
    expect(waited()).toBe(false);
    expect(wake.settled()).toBe(true);
  });

  it('doubles the settle for each sleep before it settled, up to the ceiling', () => {
    const c = wallClock();
    const wake = watchWake(c.now);
    const sleep = (ms: number) => { const waited = wake.begin(50); c.pass(ms); expect(waited()).toBe(true); };
    sleep(60 * 60_000);
    const seen: number[] = [wake.settleMs()];
    for (let i = 0; i < 4; i += 1) {
      c.pass(wake.settleMs() - 1_000);
      sleep(10 * 60_000);
      seen.push(wake.settleMs());
    }
    expect(seen).toEqual([WAKE_SETTLE_MS, WAKE_SETTLE_MS * 2, WAKE_SETTLE_MS * 4, WAKE_SETTLE_MAX_MS, WAKE_SETTLE_MAX_MS]);
  });

  it('doubles the settle for a sleep under a run, and returns it to the base when a run ends held', () => {
    const c = wallClock();
    const wake = watchWake(c.now);
    wake.driving(true);
    const waited = wake.begin(50);
    c.pass(10 * 60_000);
    expect(waited()).toBe(true);
    wake.driving(false);
    expect(wake.settleMs()).toBe(WAKE_SETTLE_MS * 2);
    wake.ranThrough();
    expect(wake.settleMs()).toBe(WAKE_SETTLE_MS);
  });

  it('does not lengthen the settle for a sleep after the machine had settled', () => {
    const c = wallClock();
    const wake = watchWake(c.now);
    let waited = wake.begin(50);
    c.pass(10 * 60_000);
    waited();
    c.pass(WAKE_SETTLE_MS + 1_000);
    waited = wake.begin(50);
    c.pass(10 * 60_000);
    waited();
    expect(wake.settleMs()).toBe(WAKE_SETTLE_MS);
  });

  it('returns the settle to its base once the machine stays awake for the ceiling', () => {
    const c = wallClock();
    const wake = watchWake(c.now);
    const sleep = () => { const waited = wake.begin(50); c.pass(10 * 60_000); waited(); };
    sleep();
    c.pass(1_000);
    sleep();
    expect(wake.settleMs()).toBe(WAKE_SETTLE_MS * 2);
    c.pass(WAKE_SETTLE_MAX_MS);
    expect(wake.settleMs()).toBe(WAKE_SETTLE_MS);
  });
});

/** A spawn that records what it was asked and hands back a child a test controls. */
function fakeSpawn(options: { throws?: boolean } = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const children: Array<EventEmitter & { kills: string[] }> = [];
  const spawn: KeepAwakeDeps['spawn'] = (command, args) => {
    calls.push({ command, args });
    if (options.throws === true) throw new Error('spawn failed');
    const child = Object.assign(new EventEmitter(), {
      kills: [] as string[],
      unref: () => {},
      kill(signal?: NodeJS.Signals | number) { this.kills.push(String(signal)); return true; },
    });
    children.push(child);
    return child as unknown as ReturnType<KeepAwakeDeps['spawn']>;
  };
  return { spawn, calls, children };
}

describe('keeping the machine awake while a run is driven', () => {
  it('holds caffeinate against idle and system sleep, ended with the worker\'s own process', () => {
    const f = fakeSpawn();
    const release = keepAwakeWith({ platform: 'darwin', pid: 4242, spawn: f.spawn })();
    expect(f.calls).toEqual([{ command: CAFFEINATE, args: ['-i', '-s', '-w', '4242'] }]);
    release();
    expect(f.children[0]!.kills).toEqual(['SIGTERM']);
  });

  it('releases once however often it is released, and not a process that already ended', () => {
    const f = fakeSpawn();
    const release = keepAwakeWith({ platform: 'darwin', pid: 1, spawn: f.spawn })();
    release();
    release();
    expect(f.children[0]!.kills).toEqual(['SIGTERM']);
    const again = keepAwakeWith({ platform: 'darwin', pid: 1, spawn: f.spawn })();
    f.children[1]!.emit('exit', 0, null);
    again();
    expect(f.children[1]!.kills).toEqual([]);
  });

  it('holds nothing off macOS', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const f = fakeSpawn();
      keepAwakeWith({ platform, pid: 1, spawn: f.spawn })()();
      expect({ platform, calls: f.calls }).toEqual({ platform, calls: [] });
    }
  });

  it('drives the run anyway where caffeinate cannot be started', () => {
    const throwing = fakeSpawn({ throws: true });
    expect(() => keepAwakeWith({ platform: 'darwin', pid: 1, spawn: throwing.spawn })()()).not.toThrow();
    // A binary that is missing is reported by the child as an error event, not a throw.
    const missing = fakeSpawn();
    const release = keepAwakeWith({ platform: 'darwin', pid: 1, spawn: missing.spawn })();
    missing.children[0]!.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(() => { release(); }).not.toThrow();
    expect(missing.children[0]!.kills).toEqual([]);
  });

  it('is what `myco worker` holds while it drives', () => {
    expect(attachOptions('https://deployment.example', '/fixture/myco-no-home').keepAwake).toBe(keepMachineAwake);
  });
});

describe('what `myco worker` writes to its log', () => {
  it('stamps each line with the ISO instant it was written', () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    try {
      attachOptions('https://deployment.example', '/fixture/myco-no-home').log('claimed run_1 (extract-curate) on claude-code, budget 900s');
    } finally {
      console.log = original;
    }
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z worker: claimed run_1 \(extract-curate\) on claude-code, budget 900s$/);
  });
});
