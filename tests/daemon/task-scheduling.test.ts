import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerScheduledTasks } from '@myco/daemon/task-scheduling.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { ProjectPowerStateTracker } from '@myco/daemon/project-power-state.js';
import type { AgentTask } from '@myco/agent/types.js';

mock.module('@myco/agent/registry.js', () => ({
  loadAllTasks: () => new Map<string, AgentTask>([
    ['vault-evolve', {
      name: 'vault-evolve',
      displayName: 'Vault Evolve',
      description: 'test',
      agent: 'myco-agent',
      prompt: 'test',
      isDefault: false,
      schedule: { enabled: true, intervalSeconds: 300, runIn: ['idle'] },
    }],
  ]),
}));

mock.module('@myco/db/client.js', () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [] }),
  }),
  withDatabase: <T,>(_db: unknown, fn: () => T) => fn(),
}));

describe('registerScheduledTasks', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  let vaultDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sched-'));
    ensureProjectManifest(vaultDir, { projectName: 'task-sched-test' });
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('replaces scheduled jobs when task schedule overrides change', async () => {
    const powerManager = {
      replaceGroup: vi.fn(),
    };
    const liveConfig = {
      current: {
        agent: {
          scheduled_tasks_enabled: true,
          tasks: {
            'vault-evolve': {
              schedule: { enabled: true },
            },
          },
        },
      },
    };

    const baseDeps = {
      definitionsDir: '/tmp/defs',
      vaultDir,
      embeddingManager: {} as never,
      logger: logger as never,
      cache: new GroveRuntimeCache(),
      mycoHome: vaultDir,
      machineId: 'test-machine',
      projectStateTracker: new ProjectPowerStateTracker({
        idleThresholdMs: 60_000,
        sleepThresholdMs: 5 * 60_000,
        deepSleepThresholdMs: 30 * 60_000,
      }),
    };

    await registerScheduledTasks(powerManager as never, {
      ...baseDeps,
      liveConfig: liveConfig as never,
    });

    // Collapsed scheduler emits exactly one PowerJob; per-task gating is internal.
    expect(powerManager.replaceGroup).toHaveBeenLastCalledWith(
      'scheduled:',
      expect.arrayContaining([
        expect.objectContaining({ name: 'scheduled:tasks' }),
      ]),
    );

    liveConfig.current = {
      agent: {
        scheduled_tasks_enabled: true,
        tasks: {
          'vault-evolve': {
            schedule: { enabled: false },
          },
        },
      },
    };

    await registerScheduledTasks(powerManager as never, {
      ...baseDeps,
      liveConfig: liveConfig as never,
    });

    // No enabled tasks → buildScheduledJobs returns no jobs.
    expect(powerManager.replaceGroup).toHaveBeenLastCalledWith('scheduled:', []);
  });
});
