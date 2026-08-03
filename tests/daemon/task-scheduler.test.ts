import { describe, it, expect } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import {
  buildScheduledJobs,
  computeEffectiveInterval,
  type ScheduledJobContext,
} from '@myco/daemon/task-scheduler.js';
import type { ProjectScope } from '@myco/daemon/scope-iteration.js';
import type { AcceleratorConfig, AgentTask } from '@myco/agent/types.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

const PROJECT_A = assertGroveProjectId('proj_' + 'a'.repeat(32));
const PROJECT_B = assertGroveProjectId('proj_' + 'b'.repeat(32));
const GROVE_X = 'grv_' + 'c'.repeat(32);

function fakeScope(projectId: GroveProjectId, groveId: string = GROVE_X): ProjectScope {
  // Tests don't exercise the inner ProjectScope shape; the scheduler reads
  // grove.id, projectId, and (for some pre-conditions) requestContext.
  return {
    grove: { id: groveId, slug: groveId } as unknown as ProjectScope['grove'],
    groveHome: '',
    databasePath: '',
    db: {} as ProjectScope['db'],
    project: {} as ProjectScope['project'],
    projectId,
    projectRoot: '',
    projectVaultDir: '',
    requestContext: {} as ProjectScope['requestContext'],
  };
}

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

interface FakeContextOptions {
  projects?: ProjectScope[];
  isTaskRunning?: ScheduledJobContext['isTaskRunning'];
  setTaskRunning?: ScheduledJobContext['setTaskRunning'];
  runTask?: ScheduledJobContext['runTask'];
  preConditions?: ScheduledJobContext['preConditions'];
  accelerators?: ScheduledJobContext['accelerators'];
  onTaskError?: ScheduledJobContext['onTaskError'];
  /** Override per-project state lookup. Defaults to always 'idle'. */
  getProjectPowerState?: ScheduledJobContext['getProjectPowerState'];
  getRecentTaskRunCount?: ScheduledJobContext['getRecentTaskRunCount'];
  getTaskConfig?: ScheduledJobContext['getTaskConfig'];
  getTaskScheduleEnabled?: ScheduledJobContext['getTaskScheduleEnabled'];
  isProjectCold?: ScheduledJobContext['isProjectCold'];
}

function makeContext(opts: FakeContextOptions = {}): ScheduledJobContext {
  const projects = opts.projects ?? [fakeScope(PROJECT_A)];
  return {
    forEachProject: async (visit) => {
      for (const p of projects) {
        await visit(p);
      }
    },
    isTaskRunning: opts.isTaskRunning ?? (() => false),
    setTaskRunning: opts.setTaskRunning ?? vi.fn(),
    runTask: opts.runTask ?? vi.fn().mockResolvedValue(undefined),
    preConditions: opts.preConditions ?? {},
    accelerators: opts.accelerators,
    onTaskError: opts.onTaskError,
    getProjectPowerState: opts.getProjectPowerState ?? (() => 'idle'),
    getRecentTaskRunCount: opts.getRecentTaskRunCount,
    getTaskConfig: opts.getTaskConfig ?? (() => undefined),
    getTaskScheduleEnabled: opts.getTaskScheduleEnabled,
    isProjectCold: opts.isProjectCold,
  };
}

function key(groveId: string, projectId: GroveProjectId, taskName: string): string {
  return `${groveId}:${projectId}:${taskName}`;
}

describe('buildScheduledJobs (collapsed fan-out)', () => {
  it('emits exactly one collapsed PowerJob regardless of enabled task count', () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 300, runIn: ['active', 'idle'] }),
      makeTask('task-b', { enabled: true, intervalSeconds: 600, runIn: ['idle'] }),
      makeTask('task-c', undefined),
    ];

    const { jobs } = buildScheduledJobs(tasks, makeContext());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('scheduled:tasks');
    // The collapsed job runs in every schedulable state; per-task runIn
    // is enforced inside the loop against the per-project power state.
    expect(jobs[0].runIn).toEqual(['active', 'idle', 'sleep']);
  });

  it('respects project config to enable a disabled-by-default task', async () => {
    const tasks = [
      makeTask('skill-survey', { enabled: false, intervalSeconds: 600, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      getTaskConfig: () => ({ schedule: { enabled: true } }),
      runTask: async (s) => { calls.push(s.projectId); },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);
  });

  it('respects project config to disable an enabled-by-default task', async () => {
    const tasks = [
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 300, runIn: ['active', 'idle'] }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      getTaskConfig: () => ({ schedule: { enabled: false } }),
      runTask,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('resolves task enablement from each project config during the sweep', async () => {
    const tasks = [
      makeTask('canopy-describe', { enabled: false, intervalSeconds: 120, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      getTaskConfig: (scope, taskName) => {
        if (taskName !== 'canopy-describe') return undefined;
        return {
          schedule: {
            enabled: scope.projectId === PROJECT_A,
          },
        };
      },
      runTask: async (s) => {
        calls.push(s.projectId);
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);
  });

  it('uses the YAML default when project config is absent', async () => {
    const tasks = [
      makeTask('canopy-describe', { enabled: false, intervalSeconds: 120, runIn: ['idle'] }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      getTaskConfig: () => undefined,
      runTask,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('routes the dispatch enablement decision through the effective schedule seam', async () => {
    const tasks = [
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 120, runIn: ['idle'] }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      getTaskConfig: () => ({ schedule: { enabled: true } }),
      getTaskScheduleEnabled: () => false,
      runTask,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('dispatches a task once per project on a single tick', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    const seen: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      runTask: async (s) => {
        seen.push(s.projectId);
      },
    });

    const { jobs } = buildScheduledJobs(tasks, ctx);
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(seen.sort()).toEqual([PROJECT_A, PROJECT_B].sort());
  });

  it('throttles per project — a fast follow-up tick on the same project is gated', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 900, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(calls).toEqual([PROJECT_A]);
  });

  it("each project's interval is independent — A throttled doesn't block B", async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 900, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    let projects = [fakeScope(PROJECT_A)];
    const ctx: ScheduledJobContext = {
      forEachProject: async (visit) => {
        for (const p of projects) await visit(p);
      },
      isTaskRunning: () => false,
      setTaskRunning: vi.fn(),
      runTask: async (s) => {
        calls.push(s.projectId);
      },
      preConditions: {},
      getProjectPowerState: () => 'idle',
      getTaskConfig: () => undefined,
    };
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);

    projects = [fakeScope(PROJECT_A), fakeScope(PROJECT_B)];
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A, PROJECT_B]);
  });

  it('skips a project whose runIn does not match its current power state', async () => {
    const tasks = [
      makeTask('idle-only', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
      getProjectPowerState: (s) => (s.projectId === PROJECT_A ? 'active' : 'idle'),
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_B]);
  });

  it('skips a project whose pre-condition returns false', async () => {
    const tasks = [
      makeTask('with-pre', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        preCondition: 'has-pending-canopy-rows',
      }),
    ];
    const preCheck = vi.fn((s: ProjectScope) => s.projectId === PROJECT_A);
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
      preConditions: { 'has-pending-canopy-rows': preCheck },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);
    expect(preCheck).toHaveBeenCalledTimes(2);
  });

  it('skips a project that has the same task already running', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      isTaskRunning: (_groveId, projectId) => projectId === PROJECT_A,
      runTask: async (s) => {
        calls.push(s.projectId);
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_B]);
  });

  it('initialLastRuns seed is keyed by `${groveId}:${projectId}:${taskName}`', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 3600, runIn: ['idle'] }),
    ];
    const ctx = makeContext({ projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)] });
    const recent = Date.now() - 1_000;
    const { jobs } = buildScheduledJobs(tasks, ctx, {
      [key(GROVE_X, PROJECT_A, 'task-a')]: recent,
    });

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    // A is throttled by the seed; B has no seed → fires.
    expect(ctx.runTask).toHaveBeenCalledTimes(1);
    expect((ctx.runTask as ReturnType<typeof vi.fn>).mock.calls[0][0].projectId).toBe(PROJECT_B);
  });

  it('flags running per-project: setTaskRunning is called with grove + project + task name', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    const setRunning = vi.fn();
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      setTaskRunning: setRunning,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    expect(setRunning).toHaveBeenCalledWith(GROVE_X, PROJECT_A, 'task-a', true);

    await new Promise((r) => setImmediate(r));
    expect(setRunning).toHaveBeenCalledWith(GROVE_X, PROJECT_A, 'task-a', false);
  });

  it('routes detached task errors to onTaskError with task name + grove + projectId', async () => {
    const tasks = [
      makeTask('failing', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    const onTaskError = vi.fn();
    const boom = new Error('task exploded');
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      runTask: vi.fn().mockRejectedValue(boom),
      onTaskError,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(onTaskError).toHaveBeenCalledWith('failing', GROVE_X, PROJECT_A, boom);
  });

  it('returns immediately without awaiting the task body (fire-and-forget)', async () => {
    const tasks = [
      makeTask('long-task', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    let resolveTask: () => void = () => {};
    const taskPromise = new Promise<void>((r) => {
      resolveTask = r;
    });
    const runTask = vi.fn().mockReturnValue(taskPromise);
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      runTask,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    expect(runTask).toHaveBeenCalledTimes(1);
    resolveTask();
    await new Promise((r) => setImmediate(r));
  });

  it('reads accelerator count once per (project, task) per tick', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        accelerator: { name: 'canopy-pending-describe', thresholds: { steady: 5, accelerated: 10 } },
      }),
    ];
    const countFn = vi.fn(() => 0);
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      accelerators: { 'canopy-pending-describe': countFn },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    // Single read used for both the interval tier and the deep-sleep hold.
    expect(countFn).toHaveBeenCalledTimes(1);
  });

  it('lazy-seeds lastRun via seedMissingLastRuns on first visit', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 999_999, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const seedMissingLastRuns = vi.fn(() => new Map([['task-a', Date.now() - 1_000]]));
    const ctx: ScheduledJobContext = {
      forEachProject: async (visit) => {
        await visit(fakeScope(PROJECT_A));
      },
      isTaskRunning: () => false,
      setTaskRunning: vi.fn(),
      runTask: async (s) => { calls.push(s.projectId); },
      preConditions: {},
      getProjectPowerState: () => 'idle',
      getTaskConfig: () => undefined,
      seedMissingLastRuns,
    };
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    // Recently-seeded tuple suppresses the dispatch.
    expect(calls).toEqual([]);
    expect(seedMissingLastRuns).toHaveBeenCalledTimes(1);

    // Second tick on the same project does not re-seed.
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(seedMissingLastRuns).toHaveBeenCalledTimes(1);
  });
});

describe('kicker', () => {
  it('kick(taskName, target) bypasses the interval gate for that (grove, project) only', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 999_999, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls.sort()).toEqual([PROJECT_A, PROJECT_B].sort());
    calls.length = 0;

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([]);

    kicker.kick('task-a', { groveId: GROVE_X, projectId: PROJECT_A });
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);
  });

  it('kick(taskName) without a target broadcasts to every project once', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 999_999, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    calls.length = 0;

    kicker.kick('task-a');
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls.sort()).toEqual([PROJECT_A, PROJECT_B].sort());
    calls.length = 0;

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([]);
  });

  it('multiple kicks for the same target before a tick collapse to one', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 999_999, runIn: ['idle'] }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    calls.length = 0;

    const target = { groveId: GROVE_X, projectId: PROJECT_A };
    kicker.kick('task-a', target);
    kicker.kick('task-a', target);
    kicker.kick('task-a', target);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([PROJECT_A]);
  });

  it('kick still respects in-flight overlap', async () => {
    const tasks = [
      makeTask('task-a', { enabled: true, intervalSeconds: 1, runIn: ['idle'] }),
    ];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      isTaskRunning: () => true,
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, ctx);

    kicker.kick('task-a', { groveId: GROVE_X, projectId: PROJECT_A });
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(ctx.runTask).not.toHaveBeenCalled();
  });

  it('kick still respects pre-condition gate', async () => {
    const tasks = [
      makeTask('task-a', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        preCondition: 'has-pending-canopy-rows',
      }),
    ];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      preConditions: { 'has-pending-canopy-rows': () => false },
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, ctx);

    kicker.kick('task-a', { groveId: GROVE_X, projectId: PROJECT_A });
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(ctx.runTask).not.toHaveBeenCalled();
  });
});

describe('accelerator-driven cadence (per project)', () => {
  const acc: AcceleratorConfig = {
    name: 'canopy-pending-describe',
    thresholds: { steady: 50, accelerated: 500 },
  };

  it('shrinks the effective interval per project based on each project\'s backlog', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['idle'],
        accelerator: acc,
      }),
    ];
    const calls: GroveProjectId[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A), fakeScope(PROJECT_B)],
      runTask: async (s) => {
        calls.push(s.projectId);
      },
      accelerators: {
        'canopy-pending-describe': (s) => (s.projectId === PROJECT_A ? 1000 : 0),
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx, {
      [key(GROVE_X, PROJECT_A, 'canopy-describe')]: Date.now() - 11_000,
      [key(GROVE_X, PROJECT_B, 'canopy-describe')]: Date.now() - 11_000,
    });

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(calls).toEqual([PROJECT_A]);
  });

  it('per-project deep-sleep hold is consulted via getProjectPowerState', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['idle', 'sleep'],
        accelerator: acc,
      }),
    ];
    const seen: Array<{ projectId: GroveProjectId; hold: boolean }> = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      accelerators: { 'canopy-pending-describe': () => 25 },
      getProjectPowerState: (s, hold) => {
        seen.push({ projectId: s.projectId, hold });
        return 'sleep';
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(seen.some((entry) => entry.hold === true)).toBe(true);
  });

  it('omits accelerator hold when the count function throws', async () => {
    const tasks = [
      makeTask('canopy-describe', {
        enabled: true,
        intervalSeconds: 120,
        runIn: ['idle'],
        accelerator: acc,
      }),
    ];
    const seen: boolean[] = [];
    const ctx = makeContext({
      projects: [fakeScope(PROJECT_A)],
      accelerators: {
        'canopy-pending-describe': () => {
          throw new Error('db unavailable');
        },
      },
      getProjectPowerState: (_, hold) => {
        seen.push(hold);
        return 'idle';
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([false]);
  });
});

describe('computeEffectiveInterval (adaptive cadence tier function)', () => {
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
    expect(computeEffectiveInterval(120, 501, canopyCfg.thresholds)).toBe(10);
    expect(computeEffectiveInterval(120, 2000, canopyCfg.thresholds)).toBe(10);
  });

  it('honors a longer YAML interval proportionally', () => {
    expect(computeEffectiveInterval(600, 0, canopyCfg.thresholds)).toBe(600);
    expect(computeEffectiveInterval(600, 250, canopyCfg.thresholds)).toBe(150);
    expect(computeEffectiveInterval(600, 1000, canopyCfg.thresholds)).toBe(50);
  });
});

describe('maxRunsPerDay ceiling', () => {
  it('dispatches when recent run count is below the ceiling', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        maxRunsPerDay: 6,
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      getRecentTaskRunCount: () => 3,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('skips dispatch when recent run count is at the ceiling', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        maxRunsPerDay: 6,
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      getRecentTaskRunCount: () => 6,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('skips dispatch when recent run count exceeds the ceiling', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        maxRunsPerDay: 6,
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      getRecentTaskRunCount: () => 12,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('honors the ceiling even when a kick bypasses interval throttling', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 999_999,
        runIn: ['idle'],
        maxRunsPerDay: 6,
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      getRecentTaskRunCount: () => 6,
    });
    const { jobs, kicker } = buildScheduledJobs(tasks, ctx);

    kicker.kick('cap-task', { groveId: GROVE_X, projectId: PROJECT_A });
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('falls through to interval throttling when the counter throws', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        maxRunsPerDay: 6,
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      getRecentTaskRunCount: () => {
        throw new Error('boom');
      },
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('skips the ceiling check entirely when the counter is omitted', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        maxRunsPerDay: 6,
      }),
    ];
    const runTask = vi.fn().mockResolvedValue(undefined);
    // No getRecentTaskRunCount provided.
    const ctx = makeContext({ runTask });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('does not consult the counter when maxRunsPerDay is unset', async () => {
    const tasks = [
      makeTask('cap-task', {
        enabled: true,
        intervalSeconds: 1,
        runIn: ['idle'],
        // maxRunsPerDay omitted.
      }),
    ];
    const counter = vi.fn(() => 100);
    const runTask = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      runTask,
      getRecentTaskRunCount: counter,
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(counter).not.toHaveBeenCalled();
    expect(runTask).toHaveBeenCalledTimes(1);
  });
});

describe('cold-project gate (task-aware via runWhenCold)', () => {
  it('skips tasks on a cold project by default', async () => {
    const runTask = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 60, runIn: ['idle'] }),
    ];
    const ctx = makeContext({ runTask, isProjectCold: () => true });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('runs runWhenCold catch-up tasks on a cold project', async () => {
    const runTask = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      makeTask('canopy-describe', { enabled: true, intervalSeconds: 60, runIn: ['idle'], runWhenCold: true }),
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 60, runIn: ['idle'] }),
    ];
    const ctx = makeContext({ runTask, isProjectCold: () => true });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(expect.anything(), 'canopy-describe');
  });

  it('honors a project-config runWhenCold override on a cold project', async () => {
    const runTask = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 60, runIn: ['idle'] }),
    ];
    const ctx = makeContext({
      runTask,
      isProjectCold: () => true,
      getTaskConfig: () => ({ schedule: { runWhenCold: true } }),
    });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('runs everything when the project is warm', async () => {
    const runTask = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      makeTask('vault-evolve', { enabled: true, intervalSeconds: 60, runIn: ['idle'] }),
    ];
    const ctx = makeContext({ runTask, isProjectCold: () => false });
    const { jobs } = buildScheduledJobs(tasks, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);
  });
});
