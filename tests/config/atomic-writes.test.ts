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
  test.skipIf(process.platform === 'win32')('saveConfig writes atomically via temp + rename', () => {
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
  test.skipIf(process.platform === 'win32')(
    'flushes and closes the tempfile before invoking the publication primitive',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-order-'));
      const finalPath = join(dir, 'secrets.env');
      const events: string[] = [];
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalClose = fs.closeSync.bind(fs);
      const originalRename = fs.renameSync.bind(fs);
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        events.push('fsync');
        originalFsync(fd);
      });
      const closeSpy = spyOn(fs, 'closeSync').mockImplementation((fd) => {
        events.push('close');
        originalClose(fd);
      });
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        events.push('publish');
        originalRename(source, destination);
      });

      try {
        atomicWriteFileSync(finalPath, 'TOKEN=abc\n', { mode: 0o600 });
      } finally {
        renameSpy.mockRestore();
        closeSpy.mockRestore();
        fsyncSpy.mockRestore();
      }

      expect(events).toEqual(['fsync', 'close', 'publish']);
      expect(readFileSync(finalPath, 'utf-8')).toBe('TOKEN=abc\n');
    },
  );

  test('opens the tempfile O_EXCL with the requested mode (no umask window)', () => {
    // The previous implementation used writeFileSync + chmodSync, which
    // briefly exposed the tempfile at the default umask (0o644 typical)
    // before chmod tightened it — a TOCTOU read window for same-user
    // attackers. The new implementation calls openSync with O_CREAT |
    // O_EXCL | O_WRONLY and the requested mode so the file lands with
    // the right bits on the open() syscall itself.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-mode-'));
    const finalPath = join(dir, 'secrets.env');

    const openSpy = spyOn(fs, 'openSync');
    const renameSpy = spyOn(fs, 'renameSync');
    try {
      atomicWriteFileSync(finalPath, 'TOKEN=abc\n', { mode: 0o600 });

      // openSync must fire on the tempfile with O_CREAT|O_EXCL|O_WRONLY
      // and the requested mode.
      expect(openSpy).toHaveBeenCalled();
      const openCall = openSpy.mock.calls[0] as [string, number, number];
      expect(typeof openCall[0]).toBe('string');
      expect((openCall[0] as string).startsWith(`${finalPath}.tmp-`)).toBe(true);
      const expectedFlags =
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
      expect(openCall[1]).toBe(expectedFlags);
      expect(openCall[2]).toBe(0o600);

      if (process.platform === 'win32') {
        expect(renameSpy).not.toHaveBeenCalled();
      } else {
        expect(renameSpy).toHaveBeenCalledTimes(1);
        const renameCall = renameSpy.mock.calls[0] as [string, string];
        expect((renameCall[0] as string).startsWith(`${finalPath}.tmp-`)).toBe(true);
        expect(renameCall[1]).toBe(finalPath);
      }
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }

    // And the landed file is actually 0o600 (POSIX-only assertion).
    if (process.platform !== 'win32') {
      const mode = statSync(finalPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('tempfile path is unpredictable (random suffix, not pid+timestamp)', () => {
    // Predictable `.tmp-<pid>-<ms>` paths let a same-user attacker race
    // the write window. The new suffix is cryptographic randomness; two
    // back-to-back writes to the same final path must produce different
    // tempfile paths even within the same millisecond.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-rand-'));
    const finalPath = join(dir, 'secrets.env');
    const seen = new Set<string>();
    const openSpy = spyOn(fs, 'openSync');
    try {
      for (let i = 0; i < 5; i++) {
        atomicWriteFileSync(finalPath, `iter=${i}\n`, { mode: 0o600 });
      }
      for (const call of openSpy.mock.calls) {
        const tmp = call[0] as string;
        if (typeof tmp === 'string' && tmp.startsWith(`${finalPath}.tmp-`)) {
          seen.add(tmp);
        }
      }
    } finally {
      openSpy.mockRestore();
    }
    expect(seen.size).toBe(5);
  });

  test('legacy encoding-string form still works', () => {
    // Existing callers pass 'utf-8' as the third arg. The union signature
    // must keep them working without any mode side-effect.
    const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-legacy-'));
    const finalPath = join(dir, 'plain.txt');
    const fchmodSpy = spyOn(fs, 'fchmodSync');
    try {
      atomicWriteFileSync(finalPath, 'hello', 'utf-8');
      // No mode requested → no fchmod on the tempfile fd.
      expect(fchmodSpy).not.toHaveBeenCalled();
    } finally {
      fchmodSpy.mockRestore();
    }
    expect(readFileSync(finalPath, 'utf-8')).toBe('hello');
  });

  test.skipIf(process.platform === 'win32')('cleans up the tempfile when renameSync throws', () => {
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

  test.skipIf(process.platform !== 'win32')(
    'publishes through the native Windows replacement path',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'myco-atomic-win-native-'));
      const longDir = join(
        dir,
        'a'.repeat(80),
        'b'.repeat(80),
        'c'.repeat(80),
        'd'.repeat(80),
      );
      fs.mkdirSync(longDir, { recursive: true });
      const finalPath = join(longDir, 'secrets.env');
      expect(finalPath.length).toBeGreaterThan(260);
      writeFileSync(finalPath, 'TOKEN=old\n');
      const renameSpy = spyOn(fs, 'renameSync');
      try {
        atomicWriteFileSync(finalPath, 'TOKEN=new\n', { mode: 0o600 });
        expect(renameSpy).not.toHaveBeenCalled();
      } finally {
        renameSpy.mockRestore();
      }
      expect(readFileSync(finalPath, 'utf-8')).toBe('TOKEN=new\n');
      expect(readdirSync(longDir).some((name) => name.startsWith('secrets.env.tmp-'))).toBe(false);
    },
  );
});
