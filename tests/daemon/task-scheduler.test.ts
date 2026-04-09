import { describe, it, expect, vi } from 'vitest';
import { buildScheduledJobs } from '@myco/daemon/task-scheduler.js';
import type { AgentTask } from '@myco/agent/types.js';
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

    const jobs = buildScheduledJobs(tasks, {});
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

    const jobs = buildScheduledJobs(tasks, overrides);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('scheduled:skill-survey');
  });

  it('respects config override to disable an enabled task', () => {
    const tasks = [
      makeTask('full-intelligence', { enabled: true, intervalSeconds: 300, runIn: ['active', 'idle'] }),
    ];
    const overrides = {
      'full-intelligence': { schedule: { enabled: false } },
    };

    const jobs = buildScheduledJobs(tasks, overrides);
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

    const jobs = buildScheduledJobs(tasks, overrides, ctx);
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

    const jobs = buildScheduledJobs(tasks, {}, ctx);
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

    const jobs = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();

    expect(ctx.runTask).toHaveBeenCalledWith('fi');
  });

  it('skips when same task is already running', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const ctx = makeContext({ isTaskRunning: (name) => name === 'task-a' });

    const jobs = buildScheduledJobs(tasks, {}, ctx);
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
    const jobs = buildScheduledJobs(tasks, {}, ctx, { 'task-a': now - 1000 });
    await jobs[0].fn();
    expect(ctx.runTask).not.toHaveBeenCalled();
  });

  it('sets task running state during execution', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const setRunning = vi.fn();
    const ctx = makeContext({ setTaskRunning: setRunning });

    const jobs = buildScheduledJobs(tasks, {}, ctx);
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

    const jobs = buildScheduledJobs(tasks, {}, ctx);

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

    const jobs = buildScheduledJobs(tasks, {}, ctx);
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

    const jobs = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(setRunning).toHaveBeenCalledWith('failing', true);
    expect(setRunning).toHaveBeenCalledWith('failing', false);
  });
});
