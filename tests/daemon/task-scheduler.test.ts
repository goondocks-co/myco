import { describe, it, expect } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { buildScheduledJobs, computeEffectiveInterval } from '@myco/daemon/task-scheduler.js';
import type { AcceleratorConfig, AgentTask } from '@myco/agent/types.js';
import type { ScheduledJobContext } from '@myco/daemon/task-scheduler.js';

function makeTask(name: string, schedule: AgentTask['schedule']): AgentTask {
  return {
    name,
    displayName: name,
    description: 'test',
    agent: 'myco-agent',
    prompt: 'test',
    isDefault: false,
    schedule,
  };
}

function makeContext(overrides: Partial<ScheduledJobContext> = {}): ScheduledJobContext {
  return {
    isTaskRunning: () => false,
    setTaskRunning: vi.fn(),
    runTask: vi.fn().mockResolvedValue(undefined),
    preConditions: {},
    ...overrides,
  };
}

describe('buildScheduledJobs', () => {
  it('creates a PowerJob for each task with schedule.enabled', () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 300, runIn: ['active', 'idle'] }),
      makeTask('task-b', { enabled: false, intervalSeconds: 600, runIn: ['idle'] }),
      makeTask('task-c', undefined),
    ];

    const { jobs } = buildScheduledJobs(tasks, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('scheduled:task-a');
    expect(jobs[0].runIn).toEqual(['active', 'idle']);
  });

  it('respects config override to enable a disabled task', () => {
    const tasks = [
      makeTask('skill-survey', { enabled: false, intervalSeconds: 600, runIn: ['idle'] }),
    ];
    const overrides = {
      'skill-survey': { schedule: { enabled: true } },
    };

    const { jobs } = buildScheduledJobs(tasks, overrides);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('scheduled:skill-survey');
  });

  it('respects config override to disable an enabled task', () => {
    const tasks = [
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 300, runIn: ['active', 'idle'] }),
    ];
    const overrides = {
      'vault-evolve': { schedule: { enabled: false } },
    };

    const { jobs } = buildScheduledJobs(tasks, overrides);
    expect(jobs).toHaveLength(0);
  });

  it('merges intervalSeconds from config override', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 300, runIn: ['idle'] }),
    ];
    const overrides = {
      'task-a': { schedule: { intervalSeconds: 900 } },
    };
    const ctx = makeContext();

    const { jobs } = buildScheduledJobs(tasks, overrides, ctx);
    expect(jobs).toHaveLength(1);

    // Run once — should execute
    await jobs[0].fn();
    expect(ctx.runTask).toHaveBeenCalledWith('task-a');

    // Run again immediately — should be throttled (900s interval)
    vi.mocked(ctx.runTask).mockClear();
    await jobs[0].fn();
    expect(ctx.runTask).not.toHaveBeenCalled();
  });

  it('checks pre-condition before running', async () => {
    const tasks = [
      makeTask('fi', { enabled: true, intervalSeconds: 1, runIn: ['active'], preCondition: 'has-unprocessed-batches' }),
    ];
    const preCheck = vi.fn().mockReturnValue(false);
    const ctx = makeContext({ preConditions: { 'has-unprocessed-batches': preCheck } });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();

    expect(preCheck).toHaveBeenCalled();
    expect(ctx.runTask).not.toHaveBeenCalled();
  });

  it('runs task when pre-condition passes', async () => {
    const tasks = [
      makeTask('fi', { enabled: true, intervalSeconds: 1, runIn: ['active'], preCondition: 'has-unprocessed-batches' }),
    ];
    const preCheck = vi.fn().mockReturnValue(true);
    const ctx = makeContext({ preConditions: { 'has-unprocessed-batches': preCheck } });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();

    expect(ctx.runTask).toHaveBeenCalledWith('fi');
  });

  it('skips when same task is already running', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const ctx = makeContext({ isTaskRunning: (name) => name === 'task-a' });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();

    expect(ctx.runTask).not.toHaveBeenCalled();
  });

  it('uses initialLastRuns to seed interval', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 3600, runIn: ['active'] }),
    ];
    const ctx = makeContext();
    const now = Date.now();

    // Seed with a recent run — should be throttled
    const { jobs } = buildScheduledJobs(tasks, {}, ctx, { 'task-a': now - 1000 });
    await jobs[0].fn();
    expect(ctx.runTask).not.toHaveBeenCalled();
  });

  it('sets task running state during execution', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const setRunning = vi.fn();
    const ctx = makeContext({ setTaskRunning: setRunning });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();

    // `true` fires synchronously before dispatch.
    expect(setRunning).toHaveBeenCalledWith('task-a', true);

    // `false` fires in the detached finally — flush microtasks to observe it.
    await new Promise((r) => setImmediate(r));
    expect(setRunning).toHaveBeenCalledWith('task-a', false);
  });

  it('returns immediately without awaiting the task (fire-and-forget)', async () => {
    const tasks = [
      makeTask('long-task', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    let resolveTask: () => void = () => {};
    const taskPromise = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const ctx = makeContext({
      runTask: vi.fn().mockReturnValue(taskPromise),
    });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    // Job fn must resolve even while runTask is still pending —
    // otherwise a multi-minute agent task would block the PowerManager
    // tick loop and starve other jobs like team-sync-flush.
    await jobs[0].fn();

    expect(ctx.runTask).toHaveBeenCalledWith('long-task');
    // Task is still in flight; resolve it to let the finally clean up.
    resolveTask();
    await new Promise((r) => setImmediate(r));
  });

  it('routes detached task errors to onTaskError', async () => {
    const tasks = [
      makeTask('failing', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const onTaskError = vi.fn();
    const boom = new Error('task exploded');
    const ctx = makeContext({
      runTask: vi.fn().mockRejectedValue(boom),
      onTaskError,
    });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(onTaskError).toHaveBeenCalledWith('failing', boom);
  });

  it('clears running flag even when task throws', async () => {
    const tasks = [
      makeTask('failing', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const setRunning = vi.fn();
    const ctx = makeContext({
      runTask: vi.fn().mockRejectedValue(new Error('boom')),
      setTaskRunning: setRunning,
      onTaskError: () => {},
    });

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(setRunning).toHaveBeenCalledWith('failing', true);
    expect(setRunning).toHaveBeenCalledWith('failing', false);
  });
});

describe('computeEffectiveInterval (adaptive cadence tier function)', () => {
  // canopy-describe shape: thresholds declared in YAML. PowerManager's
  // tick rate is the real lower bound on actual fire rate; the tier
  // function only computes the gate value.
  const canopyCfg: AcceleratorConfig = {
    name: 'canopy-pending-describe',
    thresholds: { steady: 50, accelerated: 500 },
  };

  it('returns the YAML interval at zero/empty backlog (steady)', () => {
    expect(computeEffectiveInterval(120, 0, canopyCfg.thresholds)).toBe(120);
  });

  it('returns the YAML interval just below the steady threshold', () => {
    expect(computeEffectiveInterval(120, 25, canopyCfg.thresholds)).toBe(120);
    expect(computeEffectiveInterval(120, 50, canopyCfg.thresholds)).toBe(120);
  });

  it('quarters the interval in the accelerated tier', () => {
    expect(computeEffectiveInterval(120, 51, canopyCfg.thresholds)).toBe(30);
    expect(computeEffectiveInterval(120, 250, canopyCfg.thresholds)).toBe(30);
    expect(computeEffectiveInterval(120, 500, canopyCfg.thresholds)).toBe(30);
  });

  it('twelfths the interval in the burst tier (no artificial floor)', () => {
    // 120 / 12 = 10. PowerManager's tick is the real bound — anything
    // below the tick just means "fire every tick."
    expect(computeEffectiveInterval(120, 501, canopyCfg.thresholds)).toBe(10);
    expect(computeEffectiveInterval(120, 2000, canopyCfg.thresholds)).toBe(10);
  });

  it('honors a longer YAML interval proportionally (cost-conscious user)', () => {
    expect(computeEffectiveInterval(600, 0, canopyCfg.thresholds)).toBe(600);
    expect(computeEffectiveInterval(600, 250, canopyCfg.thresholds)).toBe(150);
    expect(computeEffectiveInterval(600, 1000, canopyCfg.thresholds)).toBe(50);
  });

  // vault-evolve shape: lower thresholds.
  const vaultCfg: AcceleratorConfig = {
    name: 'unprocessed-settled-batches',
    thresholds: { steady: 5, accelerated: 25 },
  };

  it('applies the same divisors with task-specific thresholds', () => {
    expect(computeEffectiveInterval(21600, 3, vaultCfg.thresholds)).toBe(21600);   // steady
    expect(computeEffectiveInterval(21600, 10, vaultCfg.thresholds)).toBe(5400);   // accelerated
    expect(computeEffectiveInterval(21600, 50, vaultCfg.thresholds)).toBe(1800);   // burst (21600/12)
    expect(computeEffectiveInterval(3600, 50, vaultCfg.thresholds)).toBe(300);     // burst (3600/12)
  });
});

describe('buildScheduledJobs adaptive cadence', () => {
  it('uses YAML interval verbatim when no accelerator is declared (regression)', async () => {
    const tasks = [
      makeTask('plain', { enabled: true, intervalSeconds: 1000, runIn: ['active'] }),
    ];
    let calls = 0;
    const ctx = makeContext({
      runTask: vi.fn().mockImplementation(async () => { calls++; }),
      // count fns registered but the task doesn't reference them.
      accelerators: {
        'canopy-pending-describe': () => 999,
      },
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    await jobs[0].fn();         // first call seeds lastRun
    await new Promise((r) => setImmediate(r));
    await jobs[0].fn();         // 100ms later — still within YAML interval (1000s)
    await new Promise((r) => setImmediate(r));

    expect(calls).toBe(1);      // accelerator did not affect this task
  });

  it('shrinks the effective interval when the count crosses the burst threshold', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['idle'],
        accelerator: {
          name: 'canopy-pending-describe',
          thresholds: { steady: 50, accelerated: 500 },
        },
      }),
    ];
    const ctx = makeContext({
      accelerators: { 'canopy-pending-describe': () => 1000 },  // burst tier
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    expect(jobs).toHaveLength(1);

    // Pure-function check on the YAML config — the scheduler reads
    // exactly the same config when computing effective interval.
    expect(
      computeEffectiveInterval(120, 1000, tasks[0].schedule!.accelerator!.thresholds),
    ).toBe(10);
  });

  it('kick(taskName) bypasses the interval gate on the next tick', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 999_999,    // huge interval — would never fire normally
        runIn: ['idle'],
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ runTask });
    const { jobs, kicker } = buildScheduledJobs(tasks, {}, ctx);

    // First tick — interval gate blocks (lastRun=0, but the gate test is
    // `Date.now() - lastRun < intervalMs`, and lastRun starts at 0 so the
    // gate passes the first time).  The first call always seeds lastRun
    // and dispatches once, so to exercise the kick we tick twice.
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);

    // Second tick — without the kick, the interval gate would block.
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);   // gate still blocks

    // Kick + tick — runs immediately.
    kicker.kick('canopy-describe');
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(2);

    // Kick is one-shot: the next tick is gated again.
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it('multiple kicks before the next tick collapse to a single run (idempotent)', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 999_999,
        runIn: ['idle'],
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ runTask });
    const { jobs, kicker } = buildScheduledJobs(tasks, {}, ctx);

    // Seed lastRun so the interval gate would block subsequent ticks.
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);

    // Multiple kicks before the next tick.
    kicker.kick('canopy-describe');
    kicker.kick('canopy-describe');
    kicker.kick('canopy-describe');

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(2);   // one extra run, not three

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(2);   // kick consumed
  });

  it('kick still respects the in-flight overlap guard', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 100,
        runIn: ['idle'],
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      isTaskRunning: () => true,    // already in flight
      runTask,
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, {}, ctx);

    kicker.kick('canopy-describe');
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('kick still respects the precondition gate', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 100,
        runIn: ['idle'],
        preCondition: 'has-pending-canopy-rows',
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      preConditions: { 'has-pending-canopy-rows': () => false },   // no work
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, {}, ctx);

    kicker.kick('canopy-describe');
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
    // The kick was consumed even though it didn't fire — otherwise it'd
    // re-fire forever once the precondition flips back. Verify by ticking
    // again with the precondition still false: should still not fire.
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('declares preventsDeepSleep when accelerator count > 0', () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['active', 'idle', 'sleep'],
        accelerator: {
          name: 'canopy-pending-describe',
          thresholds: { steady: 50, accelerated: 500 },
        },
      }),
    ];
    const ctx = makeContext({
      accelerators: { 'canopy-pending-describe': () => 25 },  // pending work
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    expect(jobs[0].preventsDeepSleep).toBeDefined();
    expect(jobs[0].preventsDeepSleep!()).toBe(true);
  });

  it('passes bounded count limits to accelerator checks', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['active', 'idle', 'sleep'],
        accelerator: {
          name: 'canopy-pending-describe',
          thresholds: { steady: 50, accelerated: 500 },
        },
      }),
    ];
    const limits: Array<number | undefined> = [];
    const ctx = makeContext({
      accelerators: {
        'canopy-pending-describe': (limit) => {
          limits.push(limit);
          return 1000;
        },
      },
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    expect(jobs[0].preventsDeepSleep!()).toBe(true);
    await jobs[0].fn();

    expect(limits).toEqual([1, 501]);
  });

  it('releases the hold once the accelerator count drains to zero', () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['active', 'idle', 'sleep'],
        accelerator: {
          name: 'canopy-pending-describe',
          thresholds: { steady: 50, accelerated: 500 },
        },
      }),
    ];
    let count = 25;
    const ctx = makeContext({
      accelerators: { 'canopy-pending-describe': () => count },
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    expect(jobs[0].preventsDeepSleep!()).toBe(true);
    count = 0;
    expect(jobs[0].preventsDeepSleep!()).toBe(false);
  });

  it('omits preventsDeepSleep when no accelerator is declared', () => {
    const tasks = [
      makeTask('plain', { enabled: true, intervalSeconds: 600, runIn: ['idle'] }),
    ];
    const ctx = makeContext();
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    expect(jobs[0].preventsDeepSleep).toBeUndefined();
  });

  it('preventsDeepSleep returns false when the count function throws', () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['idle'],
        accelerator: {
          name: 'canopy-pending-describe',
          thresholds: { steady: 50, accelerated: 500 },
        },
      }),
    ];
    const ctx = makeContext({
      accelerators: {
        'canopy-pending-describe': () => { throw new Error('db unavailable'); },
      },
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    // A failing count must not prevent deep sleep — defensive default
    // matching the embedding reconciler's hold pattern.
    expect(jobs[0].preventsDeepSleep!()).toBe(false);
  });

  it('skips the run when the in-flight overlap guard is active, even at burst rate', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['idle'],
        accelerator: {
          name: 'canopy-pending-describe',
          thresholds: { steady: 50, accelerated: 500 },
        },
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      isTaskRunning: () => true,    // already in flight
      runTask,
      accelerators: { 'canopy-pending-describe': () => 9999 },
    });
    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    await jobs[0].fn();
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(runTask).not.toHaveBeenCalled();
  });
});
