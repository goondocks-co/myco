import { describe, test, expect, spyOn } from 'bun:test';
import fs, { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../../packages/myco/src/config/loader.js';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema.js';

// Smallest valid config: schema requires `version: 3`; every other field
// is defaulted. We re-parse through the schema so the test data tracks
// whatever defaults the schema adds today, instead of hard-coding them.
const validConfig = MycoConfigSchema.parse({ version: 3 });

describe('config atomic writes', () => {
  test('saveConfig writes atomically via temp + rename', () => {
    // Non-vacuous regression check: if anyone reverts a converted call
    // site to a direct writeFileSync, renameSync won't be called and
    // this test fails. The temp-path naming is the atomic-write helper's
    // contract — we assert the shape so a refactor that breaks it
    // (e.g. dropping the unique suffix) also trips this test.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-'));
    const finalPath = join(dir, 'myco.yaml');
    const spy = spyOn(fs, 'renameSync');
    try {
      saveConfig(dir, validConfig);
      expect(spy).toHaveBeenCalledTimes(1);
      const [tmpPath, target] = spy.mock.calls[0] as [string, string];
      expect(target).toBe(finalPath);
      expect(tmpPath.startsWith(`${finalPath}.tmp-`)).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // And the final file must contain the written content — i.e. the
    // rename actually landed, not just that it was called.
    const after = readFileSync(finalPath, 'utf-8');
    expect(after).toContain('version: 3');
  });

  test('saveConfig with sibling tempfile present is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-'));
    // Stale tempfile from a prior interrupted write.
    writeFileSync(join(dir, 'myco.yaml.tmp-stale'), 'garbage');
    saveConfig(dir, validConfig);
    const content = readFileSync(join(dir, 'myco.yaml'), 'utf-8');
    expect(content).toContain('version: 3');
  });
});
