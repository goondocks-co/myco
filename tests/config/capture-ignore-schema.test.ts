import { describe, it, expect } from 'bun:test';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';
import { scopePolicyForPath } from '../../packages/myco/src/config/scope';

describe('capture.ignore schema', () => {
  it('defaults to empty paths + patterns', () => {
    const cfg = MycoConfigSchema.parse({ version: 3 }) as any;
    expect(cfg.capture.ignore).toEqual({ paths: [], patterns: [] });
  });
  it('is machine-scoped via the capture prefix (no override)', () => {
    const e = scopePolicyForPath('capture.ignore.paths');
    expect(e.home).toBe('machine');
    expect(e.overridableBy).toEqual([]);
  });
});
