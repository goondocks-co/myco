/**
 * The clock's own object, in process: a tick never waits on work it launched.
 *
 * The clock holds one gate for every wake. Work a tick launched (an embedding run) that the wake awaited would hold
 * every later tick behind the whole run, so parsing, live capture and every job would slow to the run's length. Here
 * the launch never settles, and the next wake must still run on time and arm the chained wake.
 */
import { expect, it } from 'bun:test';
import { DeploymentClock } from '@myco-server-worker/platform/cloudflare/deployment-clock.js';
import { CHAINED_WAKE_MS, type TickReport } from '@myco-server-worker/core/tick.js';

/** The alarm and waitUntil a Durable Object is given, held where a test can read them. */
function state() {
  let alarm: number | null = null;
  const kept: Promise<unknown>[] = [];
  return {
    kept,
    alarm: () => alarm,
    ctx: {
      storage: {
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => { alarm = at; },
        deleteAlarm: async () => { alarm = null; },
      },
      waitUntil: (work: Promise<unknown>) => { kept.push(work); },
    },
  };
}

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
