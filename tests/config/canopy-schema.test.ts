import { describe, it, expect } from 'bun:test';
import { MycoConfigSchema } from '@myco/config/schema';

describe('Canopy config defaults', () => {
  const minimal = { version: 3 };

  it('applies canopy collection defaults', () => {
    const cfg = MycoConfigSchema.parse(minimal);
    expect(cfg.canopy.refresh.background_enabled).toBe(true);
    expect(cfg.canopy.refresh.background_period).toBe('1h');
    expect(cfg.canopy.exclude.patterns).toContain('node_modules');
    expect(cfg.canopy.exclude.patterns).toContain('.git');
    expect(cfg.canopy.exclude.patterns).toContain('**/package-lock.json');
  });

  it('applies cortex.canopy injection defaults', () => {
    const cfg = MycoConfigSchema.parse(minimal);
    expect(cfg.cortex.canopy.injection.enabled).toBe(true);
    expect(cfg.cortex.canopy.injection.size_threshold).toBe(800);
  });

  it('applies cortex.canopy LLM defaults — off by default, low tier', () => {
    const cfg = MycoConfigSchema.parse(minimal);
    expect(cfg.cortex.canopy.llm.enabled).toBe(false);
    expect(cfg.cortex.canopy.llm.reasoning_tier).toBe('low');
    expect(cfg.cortex.canopy.llm.prompt_ref).toBe('canopy-describe');
    expect(cfg.cortex.canopy.llm.max_description_chars).toBe(180);
    expect(cfg.cortex.canopy.llm.max_attempts).toBe(2);
  });

  it('accepts partial overrides and merges with defaults', () => {
    const cfg = MycoConfigSchema.parse({
      version: 3,
      canopy: { refresh: { background_period: '30m' } },
      cortex: { canopy: { injection: { enabled: false } } },
    });
    expect(cfg.canopy.refresh.background_period).toBe('30m');
    expect(cfg.canopy.refresh.background_enabled).toBe(true); // preserved default
    expect(cfg.cortex.canopy.injection.enabled).toBe(false);
    expect(cfg.cortex.canopy.injection.size_threshold).toBe(800); // preserved default
  });

  it('rejects invalid reasoning_tier', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      cortex: { canopy: { llm: { reasoning_tier: 'extreme' } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer size_threshold', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      cortex: { canopy: { injection: { size_threshold: 1.5 } } },
    });
    expect(result.success).toBe(false);
  });
});
