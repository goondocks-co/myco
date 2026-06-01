import { describe, expect, test } from 'bun:test';
import { GroveConfigSchema, ProjectConfigSchema, PROJECT_TIER_LEGACY_FIELDS } from '@myco/config/schema';

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

describe('Grove appearance scope', () => {
  test('accepts appearance values at the Grove tier', () => {
    const parsed = GroveConfigSchema.parse({
      appearance: { theme: 'plum', mode: 'light', font: 'jetbrains-mono', density: 'compact' },
    });
    expect(parsed.appearance).toEqual({
      theme: 'plum',
      mode: 'light',
      font: 'jetbrains-mono',
      density: 'compact',
    });
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

  test('still accepts cortex, capture, notifications, and strips appearance', () => {
    const parsed = ProjectConfigSchema.parse({
      version: 3,
      config_version: 10,
      cortex: { enabled: true },
      capture: {},
      notifications: { enabled: true },
      appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'normal' },
    });
    expect(parsed.cortex.enabled).toBe(true);
    expect(parsed).not.toHaveProperty('appearance');
  });
});

describe('PROJECT_TIER_LEGACY_FIELDS', () => {
  test('includes the 11 Grove-promoted paths — loader strips them when Grove-bound', () => {
    // These paths are Grove-tier. The loader strips them from project myco.yaml
    // when the project is Grove-bound (gated by hasGrove), so stale project-tier
    // values never shadow Grove config.
    const stringified = PROJECT_TIER_LEGACY_FIELDS.map((p) => p.join('.'));
    expect(stringified).toContain('embedding.provider');
    expect(stringified).toContain('embedding.model');
    expect(stringified).toContain('embedding.base_url');
    expect(stringified).toContain('agent.provider');
    expect(stringified).toContain('agent.harness');
    expect(stringified).toContain('agent.model');
    expect(stringified).toContain('agent.tasks');
    expect(stringified).toContain('agent.summary_batch_interval');
    expect(stringified).toContain('agent.scheduled_tasks_enabled');
    expect(stringified).toContain('agent.event_tasks_enabled');
    expect(stringified).toContain('agent.cold_project_threshold_days');
  });

  test('still includes the pre-existing legacy entries', () => {
    // Guard against accidental removal of the 10 pre-existing entries.
    const stringified = PROJECT_TIER_LEGACY_FIELDS.map((p) => p.join('.'));
    expect(stringified).toContain('daemon.port');
    expect(stringified).toContain('daemon.log_level');
    expect(stringified).toContain('daemon.log_retention_days');
    expect(stringified).toContain('daemon.stale_session_threshold_ms');
    expect(stringified).toContain('backup');
    expect(stringified).toContain('maintenance');
    expect(stringified).toContain('update');
    expect(stringified).toContain('team');
    expect(stringified).toContain('embedding.run_in_deep_sleep');
    expect(stringified).toContain('agent.scheduled_tasks_active_window_days');
    expect(stringified).toContain('appearance');
  });
});
