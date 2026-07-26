import { describe, it, expect } from 'bun:test';
import { MIGRATIONS, CURRENT_MIGRATION_VERSION, runMigrations } from '../../packages/myco/src/config/migrations';

function runV10(doc: Record<string, unknown>) {
  const step = MIGRATIONS.find((m) => m.version === 10);
  if (!step) throw new Error('v10 migration missing');
  step.migrate(doc, '/tmp/vault');
  return doc;
}

describe('v10 seed canopy.enabled from inject_on_pre_tool_use', () => {
  it('bumps CURRENT_MIGRATION_VERSION to 11', () => {
    expect(CURRENT_MIGRATION_VERSION).toBe(11);
  });
  it('seeds enabled=false when inject_on_pre_tool_use is false and enabled absent', () => {
    const doc = runV10({ cortex: { canopy: { inject_on_pre_tool_use: false } } });
    expect((doc.cortex as any).canopy.enabled).toBe(false);
  });
  it('seeds enabled=true when inject_on_pre_tool_use is true', () => {
    const doc = runV10({ cortex: { canopy: { inject_on_pre_tool_use: true } } });
    expect((doc.cortex as any).canopy.enabled).toBe(true);
  });
  it('leaves enabled untouched when already present', () => {
    const doc = runV10({ cortex: { canopy: { enabled: true, inject_on_pre_tool_use: false } } });
    expect((doc.cortex as any).canopy.enabled).toBe(true);
  });
  it('does not write enabled when both keys absent (Zod default handles it)', () => {
    const doc = runV10({ cortex: { canopy: {} } });
    expect('enabled' in (doc.cortex as any).canopy).toBe(false);
  });

  it('v10 appliesToLocal is not false (migration applies to local tier)', () => {
    const step = MIGRATIONS.find((m) => m.version === 10);
    expect(step?.appliesToLocal).not.toBe(false);
  });
});

describe('v10 on local tier', () => {
  it('seeds enabled=false on local.yaml when inject_on_pre_tool_use is false', () => {
    // A Personal override of inject_on_pre_tool_use must be relocated to
    // enabled so runtime gate reads the right field.
    const doc: Record<string, unknown> = {
      config_version: 9,
      cortex: { canopy: { inject_on_pre_tool_use: false } },
    };
    runMigrations(doc, '/tmp/vault', undefined, 'local');
    expect((doc.cortex as any).canopy.enabled).toBe(false);
    expect(doc.config_version).toBe(10);
  });

  it('is a no-op on an empty local.yaml (does not expand sparse doc)', () => {
    // Sparse local.yaml with no cortex block should not gain any new keys.
    const doc: Record<string, unknown> = {};
    const mutated = runMigrations(doc, '/tmp/vault', undefined, 'local');
    expect(mutated).toBe(false);
    expect(Object.keys(doc)).toHaveLength(0);
  });

  it('is a no-op on a local.yaml with cortex.canopy but no inject_on_pre_tool_use', () => {
    const doc: Record<string, unknown> = {
      config_version: 9,
      cortex: { canopy: { min_file_bytes: 500 } },
    };
    const before = JSON.stringify(doc);
    runMigrations(doc, '/tmp/vault', undefined, 'local');
    // enabled should not have been added
    expect('enabled' in (doc.cortex as any).canopy).toBe(false);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
