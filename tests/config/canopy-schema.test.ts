import { describe, it, expect } from 'bun:test';
import { MycoConfigSchema } from '@myco/config/schema';

describe('Canopy config defaults', () => {
  const minimal = { version: 3 };

  it('applies canopy collection defaults', () => {
    const cfg = MycoConfigSchema.parse(minimal);
    expect(cfg.cortex.canopy.refresh.background_enabled).toBe(true);
    expect(cfg.cortex.canopy.refresh.background_period_minutes).toBe(60);
    // The user-custom layer is empty by default; the scanner sources
    // baseline exclusions from `.gitignore`, the Myco baseline default
    // patterns, and symbiont manifests.
    expect(cfg.cortex.canopy.exclude.patterns).toEqual([]);
  });

  it('applies cortex.canopy injection defaults', () => {
    const cfg = MycoConfigSchema.parse(minimal);
    expect(cfg.cortex.canopy.inject_on_pre_tool_use).toBe(true);
    expect(cfg.cortex.canopy.min_file_bytes).toBe(800);
  });

  it('accepts partial overrides and merges with defaults', () => {
    const cfg = MycoConfigSchema.parse({
      version: 3,
      cortex: {
        canopy: {
          refresh: { background_period_minutes: 30 },
          inject_on_pre_tool_use: false,
        },
      },
    });
    expect(cfg.cortex.canopy.refresh.background_period_minutes).toBe(30);
    expect(cfg.cortex.canopy.refresh.background_enabled).toBe(true); // preserved default
    expect(cfg.cortex.canopy.inject_on_pre_tool_use).toBe(false);
    expect(cfg.cortex.canopy.min_file_bytes).toBe(800); // preserved default
  });

  it('rejects non-integer min_file_bytes', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      cortex: { canopy: { min_file_bytes: 1.5 } },
    });
    expect(result.success).toBe(false);
  });
});
