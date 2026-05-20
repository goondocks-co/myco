import { describe, expect, test } from 'bun:test';
import { GroveConfigSchema } from '@myco/config/schema';

describe('GroveAgentSchema', () => {
  test('accepts promoted agent runtime fields', () => {
    const parsed = GroveConfigSchema.parse({
      agent: {
        scheduled_tasks_active_window_days: 14,
        summary_batch_interval: 7,
        scheduled_tasks_enabled: false,
        event_tasks_enabled: true,
        cold_project_threshold_days: 30,
        model: 'claude-haiku-4-5',
        provider: { type: 'anthropic' },
        tasks: {
          'digest-only': { model: 'claude-sonnet-4-6' },
        },
      },
    });
    expect(parsed.agent.summary_batch_interval).toBe(7);
    expect(parsed.agent.scheduled_tasks_enabled).toBe(false);
    expect(parsed.agent.model).toBe('claude-haiku-4-5');
    expect(parsed.agent.tasks?.['digest-only']?.model).toBe('claude-sonnet-4-6');
  });

  test('defaults match prior project-tier defaults', () => {
    const parsed = GroveConfigSchema.parse({});
    expect(parsed.agent.summary_batch_interval).toBe(5);
    expect(parsed.agent.scheduled_tasks_enabled).toBe(true);
    expect(parsed.agent.event_tasks_enabled).toBe(true);
    expect(parsed.agent.cold_project_threshold_days).toBe(14);
  });

  test('rejects legacy runtime key', () => {
    const result = GroveConfigSchema.safeParse({
      agent: {
        runtime: 'bun',
      },
    });
    expect(result.success).toBe(false);
  });
});
