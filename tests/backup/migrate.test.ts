import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDir, resolveGroveDbPath } from '@myco/grove/paths.js';
import { loadGroveConfig, saveGroveConfig } from '@myco/config/loader.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { migrateLegacyBackups } from '@myco/backup/migrate.js';
import { createGroveBackup, listGroveBackups } from '@myco/backup/service.js';
import { resolveGroveBackupDir, migrationMarkerPath } from '@myco/backup/location.js';

interface Fixture {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  legacyDir: string;
  canonicalDir: string;
  cleanup: () => void;
}

const MACHINE = 'testmachine';

/** Write a whole-Grove (or project-scoped) dump with a parseable header + filename. */
function writeDump(dir: string, ts: number, opts: { projectId?: string } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const scope = opts.projectId ? `project=${opts.projectId}` : 'all-projects';
  const file = path.join(dir, `${MACHINE}__${ts}.sql`);
  fs.writeFileSync(
    file,
    [`-- Myco backup: machine_id=${MACHINE}, created_at=${ts}`, '-- Protocol version: 1', `-- scope: ${scope}`, ''].join('\n'),
    'utf-8',
  );
  return file;
}

function setup(backupDirOverride?: string): Fixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mig-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();

  const grove = createGrove('Solo', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const db = openDatabase(resolveGroveDbPath(grove.id, mycoHome));
  createSchema(db);
  db.close();

  const backupDir = backupDirOverride ?? path.join(workDir, 'custom-backups');
  const cfg = loadGroveConfig(grove.id, mycoHome);
  saveGroveConfig(
    grove.id,
    { ...cfg, backup: { ...cfg.backup, dir: backupDir, retention: { keep_daily: 1, keep_weekly: 0 } } },
    mycoHome,
  );

  return {
    workDir,
    mycoHome,
    grove,
    legacyDir: path.join(resolveGroveDir(grove.id, mycoHome), 'backups'),
    canonicalDir: resolveGroveBackupDir(grove.id, { mycoHome }),
    cleanup: () => {
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
      clearGroveRegistryCaches();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function sqlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

describe('migrateLegacyBackups', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => fx.cleanup());

  it('relocates legacy whole-Grove dumps into the canonical dir and drops the prune marker', () => {
    writeDump(fx.legacyDir, 1000);
    writeDump(fx.legacyDir, 2000);
    writeDump(fx.legacyDir, 3000);

    const [result] = migrateLegacyBackups({ mycoHome: fx.mycoHome });

    expect(result.moved).toBe(3);
    expect(sqlFiles(fx.legacyDir)).toHaveLength(0);
    expect(sqlFiles(fx.canonicalDir)).toHaveLength(3);
    expect(fs.existsSync(migrationMarkerPath(fx.canonicalDir))).toBe(true);
    // Visible through the service list (canonical + legacy union).
    expect(listGroveBackups(fx.grove.id, { mycoHome: fx.mycoHome })).toHaveLength(3);
  });

  it('is idempotent — a second run moves nothing and never duplicates', () => {
    writeDump(fx.legacyDir, 1000);
    writeDump(fx.legacyDir, 2000);
    migrateLegacyBackups({ mycoHome: fx.mycoHome });

    const second = migrateLegacyBackups({ mycoHome: fx.mycoHome });
    expect(second[0].moved).toBe(0);
    expect(sqlFiles(fx.canonicalDir)).toHaveLength(2);
  });

  it('quarantines project-scoped dumps instead of making them Grove-restorable', () => {
    writeDump(fx.legacyDir, 1000); // whole-Grove
    writeDump(fx.legacyDir, 2000, { projectId: `proj_${'a'.repeat(32)}` }); // project-scoped

    const [result] = migrateLegacyBackups({ mycoHome: fx.mycoHome });

    expect(result.moved).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(sqlFiles(fx.canonicalDir)).toHaveLength(1);
    expect(sqlFiles(path.join(fx.canonicalDir, '.legacy-project-scoped'))).toHaveLength(1);
    // The quarantined dump must NOT appear as a Grove backup.
    expect(listGroveBackups(fx.grove.id, { mycoHome: fx.mycoHome })).toHaveLength(1);
  });

  it('suppresses prune for exactly one backup after migration (no data loss on consolidation)', () => {
    writeDump(fx.legacyDir, 1000);
    writeDump(fx.legacyDir, 2000);
    writeDump(fx.legacyDir, 3000);
    migrateLegacyBackups({ mycoHome: fx.mycoHome });

    const db = openDatabase(resolveGroveDbPath(fx.grove.id, fx.mycoHome));
    try {
      // First backup after migration: marker consumed, prune skipped — all
      // 3 migrated dumps survive despite keep_daily=1.
      const first = createGroveBackup({ groveId: fx.grove.id, db, machineId: MACHINE, mycoHome: fx.mycoHome });
      expect(first.pruned).toBe(0);
      expect(fs.existsSync(migrationMarkerPath(fx.canonicalDir))).toBe(false);
      expect(sqlFiles(fx.canonicalDir).length).toBeGreaterThanOrEqual(4);

      // Second backup: marker gone, prune runs (keep_daily=1, keep_weekly=0).
      const second = createGroveBackup({ groveId: fx.grove.id, db, machineId: MACHINE, mycoHome: fx.mycoHome });
      expect(second.pruned).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('is a no-op when backup.dir is unset (canonical == legacy default)', () => {
    const plain = setup(undefined);
    try {
      // Clear backup.dir so canonical resolves to <groveHome>/backups.
      const cfg = loadGroveConfig(plain.grove.id, plain.mycoHome);
      saveGroveConfig(plain.grove.id, { ...cfg, backup: { ...cfg.backup, dir: undefined } }, plain.mycoHome);
      writeDump(path.join(resolveGroveDir(plain.grove.id, plain.mycoHome), 'backups'), 1000);

      const [result] = migrateLegacyBackups({ mycoHome: plain.mycoHome });
      expect(result.moved).toBe(0);
      expect(result.deduped).toBe(0);
    } finally {
      plain.cleanup();
    }
  });
});
