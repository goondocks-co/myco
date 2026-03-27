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
    expect(raw.context).toBeUndefined();
    expect(raw.team).toBeUndefined();
    expect(raw.digest).toBeUndefined();
    expect(raw.pipeline).toBeUndefined();
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
});
