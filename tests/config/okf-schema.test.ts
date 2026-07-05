import { describe, expect, it } from 'bun:test';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

describe('okf config schema', () => {
  it('parses an empty config with okf disabled and full maintain defaults', () => {
    const cfg = MycoConfigSchema.parse({ version: 3 });
    expect(cfg.okf.enabled).toBe(false);
    expect(cfg.okf.maintain.output_path).toBe('okf');
    expect(cfg.okf.maintain.include).toEqual(['spores', 'canopy', 'concepts', 'guides']);
    expect(cfg.okf.maintain.include_status).toEqual(['active']);
    expect(cfg.okf.maintain.include_undescribed_canopy).toBe(false);
    expect(cfg.okf.maintain.agent_concept_refresh).toBe(true);
    expect(cfg.okf.maintain.managed_agents_md_pointer).toBe(true);
  });

  it('returns distinct default objects on every parse (lazy-default regression guard)', () => {
    const a = MycoConfigSchema.parse({ version: 3 });
    const b = MycoConfigSchema.parse({ version: 3 });
    expect(a.okf).not.toBe(b.okf);
    expect(a.okf.maintain).not.toBe(b.okf.maintain);
    a.okf.enabled = true;
    a.okf.maintain.include_undescribed_canopy = true;
    expect(b.okf.enabled).toBe(false);
    expect(b.okf.maintain.include_undescribed_canopy).toBe(false);
  });

  it('accepts a relative output_path and explicit include subsets', () => {
    const cfg = MycoConfigSchema.parse({
      version: 3,
      okf: { enabled: true, maintain: { output_path: 'docs/knowledge', include: ['spores', 'guides'] } },
    });
    expect(cfg.okf.enabled).toBe(true);
    expect(cfg.okf.maintain.output_path).toBe('docs/knowledge');
    expect(cfg.okf.maintain.include).toEqual(['spores', 'guides']);
  });

  it('rejects unknown include kinds and statuses', () => {
    expect(() =>
      MycoConfigSchema.parse({ version: 3, okf: { maintain: { include: ['spores', 'everything'] } } }),
    ).toThrow();
    expect(() =>
      MycoConfigSchema.parse({ version: 3, okf: { maintain: { include_status: ['active', 'zombie'] } } }),
    ).toThrow();
  });
});
