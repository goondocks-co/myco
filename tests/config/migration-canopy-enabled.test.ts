import { describe, it, expect } from 'bun:test';
import { MIGRATIONS, CURRENT_MIGRATION_VERSION } from '../../packages/myco/src/config/migrations';

function runV10(doc: Record<string, unknown>) {
  const step = MIGRATIONS.find((m) => m.version === 10);
  if (!step) throw new Error('v10 migration missing');
  step.migrate(doc, '/tmp/vault');
  return doc;
}

describe('v10 seed canopy.enabled from inject_on_pre_tool_use', () => {
  it('bumps CURRENT_MIGRATION_VERSION to 10', () => {
    expect(CURRENT_MIGRATION_VERSION).toBe(10);
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
});
