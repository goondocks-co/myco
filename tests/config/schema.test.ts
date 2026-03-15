import { describe, it, expect } from 'vitest';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema';

describe('MycoConfigSchema', () => {
  it('accepts minimal valid config', () => {
    const config = { version: 1, intelligence: { backend: 'local' as const } };
    const result = MycoConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('applies defaults for omitted sections', () => {
    const config = { version: 1, intelligence: { backend: 'cloud' as const } };
    const result = MycoConfigSchema.parse(config);
    expect(result.capture.buffer_max_events).toBe(500);
    expect(result.context.max_tokens).toBe(1200);
    expect(result.team.enabled).toBe(false);
  });

  it('rejects invalid backend value', () => {
    const config = { version: 1, intelligence: { backend: 'invalid' } };
    const result = MycoConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('validates local intelligence config', () => {
    const config = {
      version: 1,
      intelligence: {
        backend: 'local' as const,
        local: {
          provider: 'ollama' as const,
          embedding_model: 'nomic-embed-text',
          summary_model: 'llama3.2',
          base_url: 'http://localhost:11434',
        },
      },
    };
    const result = MycoConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('validates cloud intelligence config', () => {
    const config = {
      version: 1,
      intelligence: {
        backend: 'cloud' as const,
        cloud: {
          summary_model: 'claude-haiku-4-5-20251001',
          embedding_provider: 'voyage' as const,
        },
      },
    };
    const result = MycoConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('validates context layer token budgets', () => {
    const config = {
      version: 1,
      intelligence: { backend: 'local' as const },
      context: {
        max_tokens: 1200,
        layers: { plans: 200, sessions: 500, memories: 300, team: 200 },
      },
    };
    const result = MycoConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts daemon config with defaults', () => {
    const config = MycoConfigSchema.parse({
      version: 1,
      intelligence: { backend: 'local' },
    });
    expect(config.daemon.log_level).toBe('info');
    expect(config.daemon.grace_period).toBe(30);
    expect(config.daemon.max_log_size).toBe(5242880);
  });

  it('accepts intelligence context_window', () => {
    const config = MycoConfigSchema.parse({
      version: 1,
      intelligence: { backend: 'local', context_window: 4096 },
    });
    expect(config.intelligence.context_window).toBe(4096);
  });
});
