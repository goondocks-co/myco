import { describe, expect, it } from 'bun:test';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

describe('okf config schema', () => {
  it('parses an empty config with okf disabled and the document-model maintain defaults', () => {
    const cfg = MycoConfigSchema.parse({ version: 3 });
    expect(cfg.okf.enabled).toBe(false);
    expect(cfg.okf.maintain.output_path).toBe('okf');
    expect(cfg.okf.maintain.scope).toEqual({ repo: true, git: true, vault: true });
    expect(cfg.okf.maintain.managed_agents_md_pointer).toBe(true);
  });

  it('returns distinct default objects on every parse (lazy-default regression guard)', () => {
    const a = MycoConfigSchema.parse({ version: 3 });
    const b = MycoConfigSchema.parse({ version: 3 });
    expect(a.okf).not.toBe(b.okf);
    expect(a.okf.maintain).not.toBe(b.okf.maintain);
    expect(a.okf.maintain.scope).not.toBe(b.okf.maintain.scope);
    a.okf.enabled = true;
    a.okf.maintain.scope.vault = false;
    expect(b.okf.enabled).toBe(false);
    expect(b.okf.maintain.scope.vault).toBe(true);
  });

  it('accepts a relative output_path and an explicit synthesis scope subset', () => {
    const cfg = MycoConfigSchema.parse({
      version: 3,
      okf: { enabled: true, maintain: { output_path: 'docs/knowledge', scope: { git: false } } },
    });
    expect(cfg.okf.enabled).toBe(true);
    expect(cfg.okf.maintain.output_path).toBe('docs/knowledge');
    // Unspecified scope leaves keep their own defaults — scope is its own
    // nested object, not an array the caller must repeat in full.
    expect(cfg.okf.maintain.scope).toEqual({ repo: true, git: false, vault: true });
  });

  it('rejects a non-boolean synthesis scope leaf', () => {
    expect(() =>
      MycoConfigSchema.parse({ version: 3, okf: { maintain: { scope: { git: 'sometimes' } } } }),
    ).toThrow();
  });

  it('silently strips the retired Myco-shaped include leaves (sporeStatus and friends) without error', () => {
    const cfg = MycoConfigSchema.parse({
      version: 3,
      okf: {
        maintain: {
          output_path: 'okf',
          // Retired leaves — none of these exist in OkfMaintainSchema anymore.
          // A myco.yaml written before this task carries them; loading it
          // must not throw, and none should survive into the parsed config.
          sporeStatus: 'all',
          include: ['spores', 'canopy', 'concepts', 'guides'],
          include_status: ['active'],
          include_undescribed_canopy: true,
          agent_concept_refresh: true,
        },
      },
    });
    expect(cfg.okf.maintain.output_path).toBe('okf');
    const maintain = cfg.okf.maintain as unknown as Record<string, unknown>;
    expect(maintain.sporeStatus).toBeUndefined();
    expect(maintain.include).toBeUndefined();
    expect(maintain.include_status).toBeUndefined();
    expect(maintain.include_undescribed_canopy).toBeUndefined();
    expect(maintain.agent_concept_refresh).toBeUndefined();
  });
});
