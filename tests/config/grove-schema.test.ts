import { describe, expect, test } from 'bun:test';
import { GroveConfigSchema, ProjectConfigSchema } from '@myco/config/schema';

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

describe('GroveEmbeddingSchema', () => {
  test('accepts provider configuration fields', () => {
    const parsed = GroveConfigSchema.parse({
      embedding: {
        run_in_deep_sleep: false,
        provider: 'ollama',
        model: 'nomic-embed-text',
        base_url: 'http://localhost:11434',
      },
    });
    expect(parsed.embedding.provider).toBe('ollama');
    expect(parsed.embedding.model).toBe('nomic-embed-text');
    expect(parsed.embedding.base_url).toBe('http://localhost:11434');
    expect(parsed.embedding.run_in_deep_sleep).toBe(false);
  });

  test('defaults preserve existing run_in_deep_sleep default', () => {
    const parsed = GroveConfigSchema.parse({});
    expect(parsed.embedding.run_in_deep_sleep).toBe(true);
  });

  test('rejects malformed base_url', () => {
    expect(() => GroveConfigSchema.parse({
      embedding: { base_url: 'not-a-url' },
    })).toThrow();
  });
});

describe('ProjectConfigSchema', () => {
  test('does not declare agent or embedding blocks', () => {
    const parsed = ProjectConfigSchema.parse({
      version: 3,
      config_version: 10,
    });
    expect(parsed).not.toHaveProperty('agent');
    expect(parsed).not.toHaveProperty('embedding');
  });

  test('still accepts cortex, capture, notifications, appearance', () => {
    const parsed = ProjectConfigSchema.parse({
      version: 3,
      config_version: 10,
      cortex: { enabled: true },
      capture: {},
      notifications: { enabled: true },
      appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'normal' },
    });
    expect(parsed.cortex.enabled).toBe(true);
  });
});
