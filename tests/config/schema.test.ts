import { describe, it, expect } from 'vitest';
import { MycoConfigSchema } from '@myco/config/schema';

describe('MycoConfigSchema v2', () => {
  const minimal = {
    version: 2,
    intelligence: {
      llm: { provider: 'ollama', model: 'gpt-oss' },
      embedding: { provider: 'ollama', model: 'bge-m3' },
    },
  };

  it('accepts minimal valid v2 config', () => {
    const result = MycoConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('applies defaults for context_window and max_tokens', () => {
    const config = MycoConfigSchema.parse(minimal);
    expect(config.intelligence.llm.context_window).toBe(8192);
    expect(config.intelligence.llm.max_tokens).toBe(1024);
  });

  it('rejects version 1 config', () => {
    const result = MycoConfigSchema.safeParse({
      version: 1,
      intelligence: { backend: 'local' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects anthropic as embedding provider', () => {
    const result = MycoConfigSchema.safeParse({
      version: 2,
      intelligence: {
        llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        embedding: { provider: 'anthropic', model: 'nope' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts anthropic as LLM provider', () => {
    const config = MycoConfigSchema.parse({
      version: 2,
      intelligence: {
        llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        embedding: { provider: 'ollama', model: 'bge-m3' },
      },
    });
    expect(config.intelligence.llm.provider).toBe('anthropic');
  });

  it('accepts custom context_window and max_tokens', () => {
    const config = MycoConfigSchema.parse({
      version: 2,
      intelligence: {
        llm: { provider: 'ollama', model: 'gpt-oss', context_window: 4096, max_tokens: 512 },
        embedding: { provider: 'lm-studio', model: 'bge-m3' },
      },
    });
    expect(config.intelligence.llm.context_window).toBe(4096);
    expect(config.intelligence.llm.max_tokens).toBe(512);
  });

  it('accepts optional base_url on providers', () => {
    const config = MycoConfigSchema.parse({
      version: 2,
      intelligence: {
        llm: { provider: 'ollama', model: 'gpt-oss', base_url: 'http://gpu-box:11434' },
        embedding: { provider: 'ollama', model: 'bge-m3', base_url: 'http://gpu-box:11434' },
      },
    });
    expect(config.intelligence.llm.base_url).toBe('http://gpu-box:11434');
  });

  it('applies defaults for omitted sections', () => {
    const config = MycoConfigSchema.parse(minimal);
    expect(config.capture.buffer_max_events).toBe(500);
    expect(config.context.max_tokens).toBe(1200);
    expect(config.daemon.log_level).toBe('info');
    expect(config.team.enabled).toBe(false);
  });

  describe('digest section', () => {
    it('populates default digest values when digest section is absent', () => {
      const config = MycoConfigSchema.parse(minimal);
      expect(config.digest.enabled).toBe(true);
      expect(config.digest.tiers).toEqual([1500, 3000, 5000, 7500]);
      expect(config.digest.inject_tier).toBe(3000);
      expect(config.digest.intelligence.provider).toBeNull();
      expect(config.digest.intelligence.model).toBeNull();
      expect(config.digest.intelligence.base_url).toBeNull();
      expect(config.digest.intelligence.context_window).toBe(32768);
      expect(config.digest.metabolism.active_interval).toBe(900);
      expect(config.digest.metabolism.cooldown_intervals).toEqual([1800, 3600, 7200]);
      expect(config.digest.metabolism.dormancy_threshold).toBe(14400);
      expect(config.digest.substrate.max_notes_per_cycle).toBe(50);
    });

    it('accepts intelligence override with nullable fields', () => {
      const config = MycoConfigSchema.parse({
        ...minimal,
        digest: {
          intelligence: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
            base_url: null,
            context_window: 16384,
          },
        },
      });
      expect(config.digest.intelligence.provider).toBe('anthropic');
      expect(config.digest.intelligence.model).toBe('claude-haiku-4-5-20251001');
      expect(config.digest.intelligence.base_url).toBeNull();
      expect(config.digest.intelligence.context_window).toBe(16384);
    });

    it('accepts custom tiers array', () => {
      const config = MycoConfigSchema.parse({
        ...minimal,
        digest: {
          tiers: [500, 1000, 2000],
        },
      });
      expect(config.digest.tiers).toEqual([500, 1000, 2000]);
    });
  });

  it('provides pipeline defaults', () => {
    const config = MycoConfigSchema.parse({ version: 2 });
    expect(config.pipeline).toEqual({
      retention_days: 30,
      batch_size: 20,
      tick_interval_seconds: 30,
      retry: {
        transient_max: 3,
        backoff_base_seconds: 30,
      },
      circuit_breaker: {
        failure_threshold: 3,
        cooldown_seconds: 300,
        max_cooldown_seconds: 3600,
      },
    });
  });
});
