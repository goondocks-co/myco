import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settings = resolve(import.meta.dir, '../../packages/myco-server/ui/src/features/admin/settings');

describe('settings have one source of effective values', () => {
  it('has no independent UI default map', () => {
    expect(existsSync(resolve(settings, 'defaults.ts'))).toBe(false);
    for (const file of ['LeafControl.tsx', 'ModelPicker.tsx', 'retired.ts']) {
      expect(readFileSync(resolve(settings, file), 'utf8')).not.toContain('LEAF_DEFAULTS');
    }
  });
});
