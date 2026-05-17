import { describe, test, expect, spyOn } from 'bun:test';
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../packages/myco/src/utils/atomic-write.js';
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

describe('atomicWriteFileSync mode option', () => {
  test('applies mode to the tempfile before rename (chmod before rename)', () => {
    // Defense against umask: even if writeFileSync's mode is masked by the
    // process umask on create, the explicit chmodSync on the tempfile must
    // land the requested mode before the rename exposes the final path.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-mode-'));
    const finalPath = join(dir, 'secrets.env');

    const chmodSpy = spyOn(fs, 'chmodSync');
    const renameSpy = spyOn(fs, 'renameSync');
    try {
      atomicWriteFileSync(finalPath, 'TOKEN=abc\n', { mode: 0o600 });

      // chmodSync must fire on the tempfile (not the final path) and must
      // be called before renameSync — the whole point of the helper.
      expect(chmodSpy).toHaveBeenCalled();
      const chmodCall = chmodSpy.mock.calls[0] as [string, number];
      expect(chmodCall[0].startsWith(`${finalPath}.tmp-`)).toBe(true);
      expect(chmodCall[1]).toBe(0o600);

      expect(renameSpy).toHaveBeenCalledTimes(1);
      const renameCall = renameSpy.mock.calls[0] as [string, string];
      expect(renameCall[0].startsWith(`${finalPath}.tmp-`)).toBe(true);
      expect(renameCall[1]).toBe(finalPath);
    } finally {
      chmodSpy.mockRestore();
      renameSpy.mockRestore();
    }

    // And the landed file is actually 0o600 (POSIX-only assertion).
    if (process.platform !== 'win32') {
      const mode = statSync(finalPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('legacy encoding-string form still works', () => {
    // Existing callers pass 'utf-8' as the third arg. The union signature
    // must keep them working without any mode side-effect.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-legacy-'));
    const finalPath = join(dir, 'plain.txt');
    const chmodSpy = spyOn(fs, 'chmodSync');
    try {
      atomicWriteFileSync(finalPath, 'hello', 'utf-8');
      // No mode requested → no chmod on the tempfile.
      const tempChmods = chmodSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith(`${finalPath}.tmp-`),
      );
      expect(tempChmods.length).toBe(0);
    } finally {
      chmodSpy.mockRestore();
    }
    expect(readFileSync(finalPath, 'utf-8')).toBe('hello');
  });

  test('cleans up the tempfile when renameSync throws', () => {
    // If rename fails (cross-device, EBUSY, ENOSPC), the tempfile must
    // not be left behind — it would otherwise sit at a predictable
    // `.tmp-<pid>-<ts>` path carrying secret bytes (auth tokens,
    // API keys) that a future read by the same user could harvest.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-rename-fail-'));
    const finalPath = join(dir, 'secrets.env');
    const fakeError = new Error('EXDEV: cross-device link not permitted');
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw fakeError;
    });
    try {
      expect(() =>
        atomicWriteFileSync(finalPath, 'TOKEN=abc\n', { mode: 0o600 }),
      ).toThrow(fakeError);
    } finally {
      renameSpy.mockRestore();
    }

    // Final path never landed.
    expect(existsSync(finalPath)).toBe(false);
    // And no tempfile lingers — the catch block unlinked it.
    const leftover = readdirSync(dir).filter((name) =>
      name.startsWith('secrets.env.tmp-'),
    );
    expect(leftover).toEqual([]);
  });
});
