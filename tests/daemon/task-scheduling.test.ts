import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { registerScheduledTasks } from '@myco/daemon/task-scheduling.js';
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
    prepare: () => ({
      all: () => [],
    }),
  }),
}));

describe('registerScheduledTasks', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

    await registerScheduledTasks(powerManager as never, {
      definitionsDir: '/tmp/defs',
      vaultDir: '/tmp/vault',
      embeddingManager: {} as never,
      logger: logger as never,
      liveConfig: liveConfig as never,
    });

    expect(powerManager.replaceGroup).toHaveBeenLastCalledWith(
      'scheduled:',
      expect.arrayContaining([
        expect.objectContaining({ name: 'scheduled:vault-evolve' }),
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
      definitionsDir: '/tmp/defs',
      vaultDir: '/tmp/vault',
      embeddingManager: {} as never,
      logger: logger as never,
      liveConfig: liveConfig as never,
    });

    expect(powerManager.replaceGroup).toHaveBeenLastCalledWith('scheduled:', []);
  });
});
