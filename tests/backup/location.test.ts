import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import { loadGroveConfig, saveGroveConfig } from '@myco/config/loader.js';
import { resolveGroveBackupDir, legacyGroveBackupLocations } from '@myco/backup/location.js';

interface Fixture {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  cleanup: () => void;
}

function setup(): Fixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-loc-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const prev = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();
  const grove = createGrove('Solo', mycoHome);
  return {
    workDir,
    mycoHome,
    grove,
    cleanup: () => {
      if (prev === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = prev;
      clearGroveRegistryCaches();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function setBackupDir(fx: Fixture, dir: string | undefined): void {
  const cfg = loadGroveConfig(fx.grove.id, fx.mycoHome);
  saveGroveConfig(fx.grove.id, { ...cfg, backup: { ...cfg.backup, dir } }, fx.mycoHome);
}

describe('resolveGroveBackupDir', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => fx.cleanup());

  it('defaults to <groveHome>/backups when backup.dir is unset', () => {
    const expected = path.resolve(resolveGroveDir(fx.grove.id, fx.mycoHome), 'backups');
    expect(resolveGroveBackupDir(fx.grove.id, { mycoHome: fx.mycoHome })).toBe(expected);
    // No legacy locations when canonical == default.
    expect(legacyGroveBackupLocations(fx.grove.id, { mycoHome: fx.mycoHome })).toHaveLength(0);
  });

  it('honors a configured backup.dir, nesting under the grove slug', () => {
    const root = path.join(fx.workDir, 'external');
    setBackupDir(fx, root);
    expect(resolveGroveBackupDir(fx.grove.id, { mycoHome: fx.mycoHome })).toBe(
      path.join(path.resolve(root), fx.grove.slug),
    );
    // The Grove-home default is now a legacy location to scan/migrate.
    expect(legacyGroveBackupLocations(fx.grove.id, { mycoHome: fx.mycoHome })).toEqual([
      path.resolve(resolveGroveDir(fx.grove.id, fx.mycoHome), 'backups'),
    ]);
  });

  it('expands a leading ~ in backup.dir', () => {
    setBackupDir(fx, '~/myco_backups/x');
    expect(resolveGroveBackupDir(fx.grove.id, { mycoHome: fx.mycoHome })).toBe(
      path.join(os.homedir(), 'myco_backups', 'x', fx.grove.slug),
    );
  });
});
