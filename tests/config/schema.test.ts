import { describe, it, expect } from 'vitest';
import { MycoConfigSchema } from '@myco/config/schema';

describe('MycoConfigSchema v3', () => {
  const minimal = {
    version: 3,
  };

  it('accepts minimal valid v3 config', () => {
    const result = MycoConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('applies embedding defaults', () => {
    const config = MycoConfigSchema.parse(minimal);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('bge-m3');
  });

  it('rejects version 1 config', () => {
    const result = MycoConfigSchema.safeParse({
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects version 2 config', () => {
    const result = MycoConfigSchema.safeParse({
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('accepts custom embedding provider and model', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'openai-compatible',
        model: 'bge-m3',
        base_url: 'http://gpu-box:11434',
      },
    });
    expect(config.embedding.provider).toBe('openai-compatible');
    expect(config.embedding.base_url).toBe('http://gpu-box:11434');
  });

  it('applies defaults for omitted sections', () => {
    const config = MycoConfigSchema.parse(minimal);
    expect(config.capture.buffer_max_events).toBe(500);
    expect(config.daemon.log_level).toBe('info');
    expect(config.daemon.port).toBeNull();
  });

  it('accepts custom capture config', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      capture: {
        transcript_paths: ['/custom/path'],
        buffer_max_events: 1000,
      },
    });
    expect(config.capture.transcript_paths).toEqual(['/custom/path']);
    expect(config.capture.buffer_max_events).toBe(1000);
  });

  it('does not include removed v2 sections', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    const raw = config as Record<string, unknown>;
    expect(raw.intelligence).toBeUndefined();
    expect(raw.team).toBeUndefined();
    expect(raw.digest).toBeUndefined();
    expect(raw.pipeline).toBeUndefined();
  });

  it('applies context injection defaults', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.context.digest_tier).toBe(5000);
    expect(config.context.prompt_search).toBe(true);
    expect(config.context.prompt_max_spores).toBe(3);
  });

  it('accepts custom context injection config', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      context: {
        digest_tier: 10000,
        prompt_search: false,
        prompt_max_spores: 5,
      },
    });
    expect(config.context.digest_tier).toBe(10000);
    expect(config.context.prompt_search).toBe(false);
    expect(config.context.prompt_max_spores).toBe(5);
  });

  it('accepts openrouter embedding provider', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small',
      },
    });
    expect(config.embedding.provider).toBe('openrouter');
  });

  it('accepts openai embedding provider', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
    });
    expect(config.embedding.provider).toBe('openai');
  });

  it('accepts plan_dirs in capture section', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      capture: { plan_dirs: ['docs/superpowers/specs/', 'docs/superpowers/plans/'] },
    });
    expect(config.capture.plan_dirs).toEqual(['docs/superpowers/specs/', 'docs/superpowers/plans/']);
  });

  it('defaults plan_dirs to empty array', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.capture.plan_dirs).toEqual([]);
  });
});
