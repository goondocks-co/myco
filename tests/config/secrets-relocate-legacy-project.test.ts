/**
 * Tests for legacy project-secrets relocation.
 *
 * The provider-secrets dashboard dropped the `project` scope, so a project
 * vault's `secrets.env` is no longer readable/maskable/deletable from the
 * UI. The one-shot, sentinel-gated global-install migration relocates and
 * purges any project `secrets.env` it finds — but ONLY once per project.
 * A project `secrets.env` that appears AFTER that sentinel is set is
 * orphaned: still consumed by `loadLayeredSecrets` at provider init, yet
 * invisible and undeletable in the dashboard.
 *
 * `relocateLegacyProjectSecrets` is the sentinel-independent guard the
 * daemon runs on every boot to close that window.
 */

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSecrets,
  createSecretsOperations,
} from '@myco/config/secrets.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const cleanups: Array<() => void> = [];
const {
  writeSecret,
  relocateLegacyProjectSecrets,
} = createSecretsOperations(testPerUserLockNamespace);
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDirs(): { vaultDir: string; mycoHome: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-vault-'));
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-home-'));
  cleanups.push(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });
  return { vaultDir, mycoHome };
}

describe('relocateLegacyProjectSecrets', () => {
  test('relocates an orphaned project secrets.env that appeared after the migration sentinel', () => {
    const { vaultDir, mycoHome } = tmpDirs();

    // A project secrets.env materializes AFTER the project was already
    // migrated (sentinel set) — e.g. a hand-placed file or resurrected
    // branch. The one-shot migration won't touch it again.
    writeSecret(vaultDir, 'ANTHROPIC_API_KEY', 'proj-anthropic');
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'proj-openai');
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(true);

    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    // Keys land at machine scope (where the dashboard can see + delete them).
    const machine = readSecrets(mycoHome);
    expect(machine.ANTHROPIC_API_KEY).toBe('proj-anthropic');
    expect(machine.OPENAI_API_KEY).toBe('proj-openai');
    expect(propagated.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

    // The project file is purged — it can never be loaded as an orphaned,
    // dashboard-invisible fallback again.
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test('machine value wins on conflict; project file still purged', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    // Newer machine-scope value must not be clobbered by a stale project copy.
    writeSecret(mycoHome, 'ANTHROPIC_API_KEY', 'machine-newer');
    writeSecret(vaultDir, 'ANTHROPIC_API_KEY', 'project-stale');

    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    expect(readSecrets(mycoHome).ANTHROPIC_API_KEY).toBe('machine-newer');
    // Already-present key is not re-propagated; it is dropped on purge.
    expect(propagated).toEqual([]);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'refuses a destination secrets.env symlink before reading or deleting the source',
    () => {
      const { vaultDir, mycoHome } = tmpDirs();
      const sourcePath = path.join(vaultDir, 'secrets.env');
      const destinationPath = path.join(mycoHome, 'secrets.env');
      fs.writeFileSync(sourcePath, 'ONLY_COPY=preserved\n', { mode: 0o600 });
      fs.symlinkSync(sourcePath, destinationPath);
      const sourceBefore = fs.readFileSync(sourcePath);

      expect(() => relocateLegacyProjectSecrets(vaultDir, mycoHome))
        .toThrow(/non-regular secret store/);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(fs.lstatSync(destinationPath).isSymbolicLink()).toBe(true);
    },
  );

  test('lifts machine-absent keys while keeping machine-present ones', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    writeSecret(mycoHome, 'ANTHROPIC_API_KEY', 'machine-anthropic');
    writeSecret(vaultDir, 'ANTHROPIC_API_KEY', 'project-anthropic');
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'project-openai');

    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    const machine = readSecrets(mycoHome);
    expect(machine.ANTHROPIC_API_KEY).toBe('machine-anthropic'); // unchanged
    expect(machine.OPENAI_API_KEY).toBe('project-openai'); // lifted
    expect(propagated).toEqual(['OPENAI_API_KEY']);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test('no-op when the project secrets.env is absent', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);
    expect(propagated).toEqual([]);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
    expect(readSecrets(mycoHome)).toEqual({});
  });

  test('refuses a same-store relocation without deleting the only secret file', () => {
    const { vaultDir } = tmpDirs();
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'only-copy');

    expect(relocateLegacyProjectSecrets(vaultDir, vaultDir)).toEqual([]);
    expect(readSecrets(vaultDir)).toEqual({ OPENAI_API_KEY: 'only-copy' });
  });

  test('idempotent — a second call after relocation is a clean no-op', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'proj-openai');

    relocateLegacyProjectSecrets(vaultDir, mycoHome);
    const second = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    expect(second).toEqual([]);
    expect(readSecrets(mycoHome).OPENAI_API_KEY).toBe('proj-openai');
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'does not unlink the source until destination file and parent publication are durable',
    () => {
      const { vaultDir, mycoHome } = tmpDirs();
      const sourcePath = path.join(vaultDir, 'secrets.env');
      fs.writeFileSync(sourcePath, 'ONLY_COPY=preserved\n', { mode: 0o600 });
      const sourceBefore = fs.readFileSync(sourcePath);
      const destinationDir = fs.realpathSync(mycoHome);
      const durabilityFailure = new Error('destination directory fsync failed');
      const originalFsync = fs.fsyncSync.bind(fs);
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        let fdPath = '';
        try { fdPath = fs.realpathSync(`/dev/fd/${fd}`); } catch { /* closed or unsupported fd */ }
        if (fdPath === destinationDir) throw durabilityFailure;
        originalFsync(fd);
      });

      try {
        expect(() => relocateLegacyProjectSecrets(vaultDir, mycoHome))
          .toThrow(durabilityFailure);
      } finally {
        fsyncSpy.mockRestore();
      }
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'syncs destination publication before unlink and the source parent after unlink',
    () => {
      const { vaultDir, mycoHome } = tmpDirs();
      const sourcePath = path.join(vaultDir, 'secrets.env');
      fs.writeFileSync(sourcePath, 'ONLY_COPY=preserved\n', { mode: 0o600 });
      const sourceDir = fs.realpathSync(vaultDir);
      const destinationDir = fs.realpathSync(mycoHome);
      const events: string[] = [];
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalRm = fs.rmSync.bind(fs);
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        let fdPath = '';
        try { fdPath = fs.realpathSync(`/dev/fd/${fd}`); } catch { /* closed or unsupported fd */ }
        if (fdPath === sourceDir || fdPath === destinationDir) events.push(`fsync:${fdPath}`);
        originalFsync(fd);
      });
      const rmSpy = spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmDirOptions) => {
        if (path.resolve(String(target)) === sourcePath) events.push('rm:source');
        originalRm(target, options);
      }) as typeof fs.rmSync);

      try {
        relocateLegacyProjectSecrets(vaultDir, mycoHome);
      } finally {
        fsyncSpy.mockRestore();
        rmSpy.mockRestore();
      }

      expect(events.indexOf(`fsync:${destinationDir}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`fsync:${destinationDir}`)).toBeLessThan(events.indexOf('rm:source'));
      expect(events.lastIndexOf(`fsync:${sourceDir}`)).toBeGreaterThan(events.indexOf('rm:source'));
    },
  );

  test.skipIf(process.platform === 'win32')(
    'revalidates the destination exact path immediately before source removal',
    () => {
      const { vaultDir, mycoHome } = tmpDirs();
      const sourcePath = path.join(vaultDir, 'secrets.env');
      const destinationPath = path.join(mycoHome, 'secrets.env');
      const displacedPath = path.join(mycoHome, 'secrets.env.displaced');
      fs.writeFileSync(sourcePath, 'ONLY_COPY=preserved\n', { mode: 0o600 });
      fs.writeFileSync(destinationPath, 'ONLY_COPY=canonical\n', { mode: 0o600 });
      const sourceBefore = fs.readFileSync(sourcePath);
      const destinationDir = fs.realpathSync(mycoHome);
      let swapped = false;
      const originalFsync = fs.fsyncSync.bind(fs);
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        let fdPath = '';
        try { fdPath = fs.realpathSync(`/dev/fd/${fd}`); } catch { /* closed or unsupported fd */ }
        originalFsync(fd);
        if (!swapped && fdPath === destinationDir) {
          swapped = true;
          fs.renameSync(destinationPath, displacedPath);
          fs.symlinkSync(sourcePath, destinationPath);
        }
      });

      try {
        expect(() => relocateLegacyProjectSecrets(vaultDir, mycoHome))
          .toThrow(/non-regular secret store/);
      } finally {
        fsyncSpy.mockRestore();
      }
      expect(swapped).toBe(true);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(fs.lstatSync(destinationPath).isSymbolicLink()).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'preserves a non-empty source when the destination disappears after publication',
    () => {
      const { vaultDir, mycoHome } = tmpDirs();
      const sourcePath = path.join(vaultDir, 'secrets.env');
      const destinationPath = path.join(mycoHome, 'secrets.env');
      fs.writeFileSync(sourcePath, 'ONLY_COPY=preserved\n', { mode: 0o600 });
      const sourceBefore = fs.readFileSync(sourcePath);
      const destinationDir = fs.realpathSync(mycoHome);
      const canonicalDestinationPath = path.join(destinationDir, 'secrets.env');
      let destinationFileSynced = false;
      let removed = false;
      const originalFsync = fs.fsyncSync.bind(fs);
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        let fdPath = '';
        try { fdPath = fs.realpathSync(`/dev/fd/${fd}`); } catch { /* closed or unsupported fd */ }
        originalFsync(fd);
        if (fdPath === canonicalDestinationPath) destinationFileSynced = true;
        if (
          !removed
          && destinationFileSynced
          && fdPath === destinationDir
        ) {
          removed = true;
          fs.rmSync(destinationPath);
        }
      });

      try {
        expect(() => relocateLegacyProjectSecrets(vaultDir, mycoHome))
          .toThrow(/destination.*disappeared/i);
      } finally {
        fsyncSpy.mockRestore();
      }
      expect(removed).toBe(true);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(fs.existsSync(destinationPath)).toBe(false);
    },
  );
});
