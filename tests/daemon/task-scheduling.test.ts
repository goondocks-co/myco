import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerScheduledTasks } from '@myco/daemon/task-scheduling.js';
import type { AgentTask } from '@myco/agent/types.js';

vi.mock('@myco/agent/registry.js', () => ({
  loadAllTasks: () => new Map<string, AgentTask>([
    ['full-intelligence', {
      name: 'full-intelligence',
      displayName: 'Full Intelligence',
      description: 'test',
      agent: 'myco-agent',
      prompt: 'test',
      isDefault: false,
      schedule: { enabled: true, intervalSeconds: 300, runIn: ['idle'] },
    }],
  ]),
}));

vi.mock('@myco/db/client.js', () => ({
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
            'full-intelligence': {
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
        expect.objectContaining({ name: 'scheduled:full-intelligence' }),
      ]),
    );

    liveConfig.current = {
      agent: {
        scheduled_tasks_enabled: true,
        tasks: {
          'full-intelligence': {
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
