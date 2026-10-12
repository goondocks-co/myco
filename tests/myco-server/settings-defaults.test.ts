import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqliteEnv } from './helpers/fixtures.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { readDispatchLimits } from '@myco-server-worker/core/limits.js';
import { effectiveSettings } from '@myco-server-worker/core/settings-policies.js';

const settings = resolve(import.meta.dir, '../../packages/myco-server/ui/src/features/admin/settings');

describe('settings have one source of effective values', () => {
  it('has no independent UI default map', () => {
    expect(existsSync(resolve(settings, 'defaults.ts'))).toBe(false);
    for (const file of ['LeafControl.tsx', 'ModelPicker.tsx', 'retired.ts']) {
      expect(readFileSync(resolve(settings, file), 'utf8')).not.toContain('LEAF_DEFAULTS');
    }
  });
});


describe('declared per-task concurrency default', () => {
  it('applies without storage, honors numeric and explicit unlimited overrides, and returns on reset', async () => {
    const f = sqliteEnv();
    const leaf = 'agent.limits.task_concurrent_runs';
    try {
      expect((await readDispatchLimits(f.serverEnv)).task_concurrent_runs).toBe(2);
      expect((await effectiveSettings(f.serverEnv)).get(leaf)).toMatchObject({ effective: 2, source: 'default' });
      expect((await settingsWriter(f.db).leaves())[leaf]).toBeUndefined();
      for (const value of [4, null]) {
        expect(await settingsWriter(f.db).setLeaf(leaf, value, 'test', 1)).toEqual({ applied: true });
        expect((await readDispatchLimits(f.serverEnv)).task_concurrent_runs).toBe(value);
        expect((await effectiveSettings(f.serverEnv)).get(leaf)).toMatchObject({ stored: value, effective: value, source: 'configured' });
      }
      expect(await settingsWriter(f.db).resetLeaf(leaf, 'test', 2)).toEqual({ applied: true });
      expect((await readDispatchLimits(f.serverEnv)).task_concurrent_runs).toBe(2);
    } finally { f.sqlite.close(); }
  });
});
