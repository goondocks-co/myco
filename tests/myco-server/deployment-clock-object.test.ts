/**
 * The clock's own object, in process: a tick never waits on work it launched.
 *
 * The clock holds one gate for every wake. Work a tick launched (an embedding run) that the wake awaited would hold
 * every later tick behind the whole run, so parsing, live capture and every job would slow to the run's length. Here
 * the launch never settles, and the next wake must still run on time and arm the chained wake.
 */
import { describe, expect, it } from 'bun:test';
import { CLOCK_LOCATION_HINT, CLOCK_NAME, clockStub, DeploymentClock, LAUNCHED_WORK_WAKE_MS, RETIRED_CLOCK_NAMES } from '@myco-server-worker/platform/cloudflare/deployment-clock.js';
import { CHAINED_WAKE_MS, WAKE_INTERVALS, type TickReport } from '@myco-server-worker/core/tick.js';
import { LAST_REQUEST_KEY } from '@myco-server-worker/core/activity.js';
import { budgetFixture } from './helpers/budget-fixture.js';

/** The alarm and waitUntil a Durable Object is given, held where a test can read them. */
function state() {
  let alarm: number | null = null;
  const stored = new Map<string, unknown>();
  const kept: Promise<unknown>[] = [];
  return {
    kept,
    alarm: () => alarm,
    ctx: {
      storage: {
        get: async <T,>(key: string) => stored.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
        delete: async (key: string) => stored.delete(key),
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => { alarm = at; },
        deleteAlarm: async () => { alarm = null; },
      },
      waitUntil: (work: Promise<unknown>) => { kept.push(work); },
    },
  };
}

it('runs maintenance on each cron floor wake while capture alarms remain paced', async () => {
  const f = await budgetFixture();
  const held = state();
  const env = { CLOCK_MODE: 'manual' };
  const reports: TickReport[] = [];
  class FixtureClock extends DeploymentClock {
    protected override clockEnv() { return { ...f.serverEnv, origin: 'https://myco.example' }; }
    protected override async tick(now: number): Promise<TickReport> {
      const report = await super.tick(now);
      reports.push(report);
      return report;
    }
  }
  const clock = new FixtureClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const realNow = Date.now;
  let now = f.now;
  Date.now = () => now;
  try {
    f.sqlite.run('INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)', [LAST_REQUEST_KEY, String(now)]);
    f.credential('reservation-owner');
    await clock.wake();
    f.sqlite.run(`INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at)
      VALUES('expired','proj_1',?,'reservation-owner',1,1)`, ['e'.repeat(64)]);
    const remaining = () => f.sqlite.query("SELECT COUNT(*) AS n FROM blob_reservations WHERE reservation_id='expired'").get();
    await clock.ensure();
    now += 2_000;
    await clock.alarm();
    expect(reports.at(-1)?.drainOnly).toBe(true);
    expect(remaining()).toEqual({ n: 1 });
    await clock.wake();
    expect(reports.at(-1)?.drainOnly).toBe(false);
    expect(remaining()).toEqual({ n: 0 });
    await clock.alarm();
    expect(reports.at(-1)?.drainOnly).toBe(true);
  } finally { Date.now = realNow; f.sqlite.close(); }
});

it('keeps the launched-work wake cap throughout failed ticks and their backoff wakes', async () => {
  const held = state();
  const env = { MYCO_ORIGIN: 'https://myco.example' };
  let ticks = 0;
  class BusyClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> {
      if (ticks++ > 0) throw new Error('fixture tick failure');
      this.clockEnv().afterResponse(() => new Promise<void>(() => {}));
      return { nextWakeMs: 300_000, jobs: [] } as unknown as TickReport;
    }
  }
  const clock = new BusyClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await clock.alarm();
    for (let wake = 0; wake < 12; wake++) {
      expect(held.alarm()! - now).toBeLessThanOrEqual(LAUNCHED_WORK_WAKE_MS);
      now = held.alarm()!;
      await clock.alarm();
    }
    expect(ticks).toBeGreaterThan(3);
  } finally { Date.now = realNow; }
});

it('retains retry deadlines and escalation across object resets and an interrupted tick', async () => {
  const held = state();
  const env = {};
  class FaultClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> { throw new Error('fixture tick failure'); }
  }
  const fresh = () => {
    const clock = new FaultClock(held.ctx as never, env as never);
    Object.assign(clock, { ctx: held.ctx, env });
    return clock;
  };
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await fresh().alarm();
    const first = held.alarm()!;
    now += 1_000;
    await fresh().ensure();
    expect(held.alarm()).toBe(first);
    expect(await fresh().wake()).toMatchObject({ ticked: false, heldBy: 'tick_backoff' });
    now = first;
    await fresh().alarm();
    expect(held.alarm()).toBe(now + 60_000);
    now = held.alarm()!;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    class InterruptedClock extends DeploymentClock {
      protected override async tick(): Promise<TickReport> { began(); return new Promise(() => {}); }
    }
    const interrupted = new InterruptedClock(held.ctx as never, env as never);
    Object.assign(interrupted, { ctx: held.ctx, env });
    void interrupted.wake();
    await started;
    const retry = held.alarm()!;
    expect(retry).toBe(now + 120_000);
    now += 1_000;
    await fresh().ensure();
    expect(held.alarm()).toBe(retry);
  } finally { Date.now = realNow; }
});

it('advances a later alarm for new work while retaining an earlier deadline', async () => {
  const held = state();
  const env = {};
  const clock = new DeploymentClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const now = Date.now();
  await held.ctx.storage.setAlarm(now + 300_000);
  await clock.ensure();
  expect(held.alarm()! - now).toBeLessThan(2_000);
  await held.ctx.storage.setAlarm(now + 100);
  await clock.ensure();
  expect(held.alarm()).toBe(now + 100);
  class RequestingClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> {
      await this.ensure();
      return { nextWakeMs: 300_000, jobs: [] } as unknown as TickReport;
    }
  }
  const requesting = new RequestingClock(held.ctx as never, env as never);
  Object.assign(requesting, { ctx: held.ctx, env });
  await requesting.wake();
  expect(held.alarm()! - now).toBeLessThan(2_000);
});

it('backs failed ticks off to a bounded deadline that new work cannot bypass, then resets after success', async () => {
  const held = state();
  const env = {};
  let fails = true;
  class FaultClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> {
      if (fails) throw new Error('fixture tick failure');
      return { nextWakeMs: 300_000, jobs: [] } as unknown as TickReport;
    }
  }
  const clock = new FaultClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt % 2 === 0) await expect(clock.wake()).rejects.toThrow('fixture tick failure');
      else await clock.alarm();
      const delay = held.alarm()! - now;
      expect(delay).toBe(Math.min(30_000 * 2 ** attempt, 300_000));
      await clock.ensure();
      expect(held.alarm()).toBe(now + delay);
      expect(await clock.wake()).toEqual({ ticked: false, heldBy: 'tick_backoff', retryInMs: delay });
      now += delay;
    }
    fails = false;
    await clock.wake();
    await clock.ensure();
    expect(held.alarm()).toBe(now + 1_000);
    fails = true;
    const setAlarm = held.ctx.storage.setAlarm;
    held.ctx.storage.setAlarm = async (at) => {
      if (at > now + 2_000) throw new Error('fixture retry storage unavailable');
      await setAlarm(at);
    };
    await expect(clock.alarm()).rejects.toThrow('fixture retry storage unavailable');
  } finally { Date.now = realNow; }
});

/** A clock whose tick launches work through the environment every tick gets, and never lets it settle. */
class LaunchingClock extends DeploymentClock {
  readonly started: number[] = [];
  protected override async tick(now: number): Promise<TickReport> {
    this.started.push(now);
    this.clockEnv().afterResponse(() => new Promise<void>(() => {}));
    return { nextWakeMs: CHAINED_WAKE_MS, jobs: [] } as unknown as TickReport;
  }
}

it('starts the next tick while work an earlier tick launched still runs, and arms the chained wake from each', async () => {
  const held = state();
  const env = { MYCO_ORIGIN: 'https://myco.example', CLOCK_MODE: undefined };
  const clock = new LaunchingClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await clock.alarm();
    expect(clock.launchedInFlight()).toBe(1);
    expect(held.alarm()).toBe(now + CHAINED_WAKE_MS);
    now += 2_000;
    // The second alarm settles on its own: nothing it waits for is the first tick's launch.
    const second = await Promise.race([clock.alarm().then(() => 'ticked'), new Promise((resolve) => setTimeout(() => resolve('held'), 200))]);
    expect(second).toBe('ticked');
    expect(clock.started).toEqual([1_000_000, 1_002_000]);
    expect(clock.launchedInFlight()).toBe(2);
    expect(held.alarm()).toBe(now + CHAINED_WAKE_MS);
    // Each launch is handed to the object to keep alive, not to the wake.
    expect(held.kept.length).toBe(2);
  } finally { Date.now = realNow; }
});

it('keeps a launch that fails from reaching the wake, and forgets it once it settles', async () => {
  const held = state();
  const env = { MYCO_ORIGIN: 'https://myco.example' };
  class FailingClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> {
      this.clockEnv().afterResponse(() => Promise.reject(new Error('the run failed')));
      return { nextWakeMs: CHAINED_WAKE_MS, jobs: [] } as unknown as TickReport;
    }
  }
  const clock = new FailingClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const logged: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { logged.push(String(line)); };
  try {
    await clock.alarm();
    await Promise.all(held.kept);
  } finally { console.log = log; }
  expect(clock.launchedInFlight()).toBe(0);
  expect(logged.map((line) => (JSON.parse(line) as { kind: string }).kind)).toContain('clock_work_failed');
});

it('wakes at least every thirty seconds while launched work still runs, so the object is never idle long enough to be evicted', async () => {
  const held = state();
  const env = { MYCO_ORIGIN: 'https://myco.example' };
  let release: () => void = () => {};
  let launch = true;
  class CadenceClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> {
      if (launch) this.clockEnv().afterResponse(() => new Promise<void>((resolve) => { release = resolve; }));
      launch = false;
      // The active cadence asks for a later wake than launched work allows.
      return { nextWakeMs: WAKE_INTERVALS.activeMs, jobs: [] } as unknown as TickReport;
    }
  }
  const clock = new CadenceClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  const realNow = Date.now;
  const now = 5_000_000;
  Date.now = () => now;
  try {
    await clock.alarm();
    expect(held.alarm()).toBe(now + LAUNCHED_WORK_WAKE_MS);
    release();
    await Promise.all(held.kept);
    await clock.alarm();
    expect(held.alarm()).toBe(now + WAKE_INTERVALS.activeMs);
  } finally { Date.now = realNow; }
});

/** A clock namespace as the platform hands one: an id per name, equal only to the id of the same name. */
function clockNamespace() {
  const idOf = (name: string) => ({ name, equals: (other: { name: string }) => other.name === name });
  const placed: Array<{ name: string; locationHint: string | undefined }> = [];
  return {
    placed,
    idOf,
    namespace: {
      idFromName: idOf,
      get: (id: { name: string }, options?: { locationHint?: string }) => { placed.push({ name: id.name, locationHint: options?.locationHint }); return { id }; },
    },
  };
}

/** A clock recording every tick it runs. */
class RecordingClock extends DeploymentClock {
  readonly ticks: number[] = [];
  protected override async tick(now: number): Promise<TickReport> {
    this.ticks.push(now);
    return { nextWakeMs: WAKE_INTERVALS.activeMs, jobs: [] } as unknown as TickReport;
  }
}

describe('where the clock is kept (#1510)', () => {
  it('addresses the clock by one name, placed beside the database primary', () => {
    const clocks = clockNamespace();
    clockStub(clocks.namespace as never);
    expect(clocks.placed).toEqual([{ name: CLOCK_NAME, locationHint: CLOCK_LOCATION_HINT }]);
    expect({ hint: CLOCK_LOCATION_HINT, retiredIncludesCurrent: RETIRED_CLOCK_NAMES.includes(CLOCK_NAME) }).toEqual({ hint: 'enam', retiredIncludesCurrent: false });
  });

  it('deletes the alarm a clock under a retired name still holds, and ticks nothing there', async () => {
    for (const name of RETIRED_CLOCK_NAMES) {
      const held = state();
      const clocks = clockNamespace();
      const ctx = { ...held.ctx, id: clocks.idOf(name) };
      await ctx.storage.setAlarm(1_000);
      const env = { MYCO_ORIGIN: 'https://myco.example', CLOCK: clocks.namespace };
      const clock = new RecordingClock(ctx as never, env as never);
      Object.assign(clock, { ctx, env });
      const outcome = await clock.wake();
      expect({ name, outcome, alarm: held.alarm(), ticks: clock.ticks }).toEqual({ name, outcome: { ticked: false, heldBy: 'retired_clock' }, alarm: null, ticks: [] });
      // Asked to wake soon, it still arms nothing.
      await clock.ensure();
      expect(held.alarm()).toBeNull();
    }
  });

  it('ticks and arms its next wake under the current name', async () => {
    const held = state();
    const clocks = clockNamespace();
    const ctx = { ...held.ctx, id: clocks.idOf(CLOCK_NAME) };
    const env = { MYCO_ORIGIN: 'https://myco.example', CLOCK: clocks.namespace };
    const clock = new RecordingClock(ctx as never, env as never);
    Object.assign(clock, { ctx, env });
    const realNow = Date.now;
    Date.now = () => 7_000_000;
    try {
      const outcome = await clock.wake();
      expect({ ticked: outcome.ticked, ticks: clock.ticks, alarm: held.alarm() }).toEqual({ ticked: true, ticks: [7_000_000], alarm: 7_000_000 + WAKE_INTERVALS.activeMs });
    } finally { Date.now = realNow; }
  });
});

it('holds a tick for an export only when its database probe also refuses', async () => {
  const f = await budgetFixture();
  let ticks = 0;
  let refusing = false;
  const held = state();
  const env = { MYCO_DB: { prepare: (query: string) => {
    if (refusing) throw new Error('D1_ERROR: D1 DB is overloaded [code: 7429]');
    return f.db.prepare(query);
  } }, CLOCK_MODE: 'manual', RECOVERY: {
    idFromName: () => 'recovery', get: () => ({ continue: async () => ({
      attempt: 3, stage: 'export', nextInMs: 0, sourcePaused: true,
    }) }),
  } };
  class FixtureClock extends DeploymentClock {
    protected override async tick(): Promise<TickReport> {
      ticks++;
      return { nextWakeMs: null, jobs: [] } as unknown as TickReport;
    }
  }
  const clock = new FixtureClock(held.ctx as never, env as never);
  Object.assign(clock, { ctx: held.ctx, env });
  try {
    expect(await clock.wake()).toMatchObject({ ticked: true });
    expect(ticks).toBe(1);
    refusing = true;
    expect(await clock.wake()).toMatchObject({ ticked: false, heldBy: 'recovery_export' });
    expect(ticks).toBe(1);
  } finally { f.sqlite.close(); }
});
