import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';

import { createGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDir, resolveGroveDbPath } from '@myco/grove/paths.js';
import { loadGroveConfig, saveGroveConfig } from '@myco/config/loader.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  createGroveBackup,
  listGroveBackups,
  restoreGroveBackup,
  previewGroveRestore,
} from '@myco/backup/service.js';
import { resolveGroveBackupDir } from '@myco/backup/location.js';

const MACHINE = 'testmachine';

interface Env {
  workDir: string;
  mycoHome: string;
  cleanup: () => void;
}

function setupEnv(): Env {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-svc-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const prev = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();
  return {
    workDir,
    mycoHome,
    cleanup: () => {
      if (prev === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = prev;
      clearGroveRegistryCaches();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function makeGrove(env: Env, name: string): GroveRecord {
  const grove = createGrove(name, env.mycoHome);
  ensureGroveDatabase(grove.id, env.mycoHome);
  const db = openDatabase(resolveGroveDbPath(grove.id, env.mycoHome));
  createSchema(db);
  db.close();
  return grove;
}

function openGroveDb(env: Env, grove: GroveRecord): Database {
  return openDatabase(resolveGroveDbPath(grove.id, env.mycoHome));
}

describe('backup service — read/write resolve the same Grove', () => {
  let env: Env;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it('a backup written for Grove A is listed for A and NOT for B', () => {
    const a = makeGrove(env, 'Alpha');
    const b = makeGrove(env, 'Beta');
    const dbA = openGroveDb(env, a);
    try {
      createGroveBackup({ groveId: a.id, db: dbA, machineId: MACHINE, mycoHome: env.mycoHome });
    } finally {
      dbA.close();
    }

    expect(listGroveBackups(a.id, { mycoHome: env.mycoHome })).toHaveLength(1);
    expect(listGroveBackups(b.id, { mycoHome: env.mycoHome })).toHaveLength(0);
  });

  it('lists across canonical AND legacy locations, deduped, newest-first', () => {
    const grove = makeGrove(env, 'Gamma');
    // Point backup.dir elsewhere so <groveHome>/backups becomes legacy.
    const cfg = loadGroveConfig(grove.id, env.mycoHome);
    saveGroveConfig(
      grove.id,
      { ...cfg, backup: { ...cfg.backup, dir: path.join(env.workDir, 'external') } },
      env.mycoHome,
    );

    // One older dump sitting in the legacy default dir...
    const legacyDir = path.join(resolveGroveDir(grove.id, env.mycoHome), 'backups');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, `${MACHINE}__1000.sql`),
      `-- Myco backup: machine_id=${MACHINE}, created_at=1000\n-- scope: all-projects\n`,
      'utf-8',
    );

    // ...and a fresh one written to the canonical dir.
    const db = openGroveDb(env, grove);
    try {
      createGroveBackup({ groveId: grove.id, db, machineId: MACHINE, mycoHome: env.mycoHome });
    } finally {
      db.close();
    }

    const all = listGroveBackups(grove.id, { mycoHome: env.mycoHome });
    expect(all).toHaveLength(2);
    // Newest-first: the just-created backup precedes the 1970-era legacy dump.
    expect(all[0].file_name).not.toBe(`${MACHINE}__1000.sql`);
    // Each entry's absolute path points at the dir it actually lives in.
    expect(all.every((b) => fs.existsSync(b.path))).toBe(true);
  });

  it('restore + preview resolve a backup by file name across locations', async () => {
    const grove = makeGrove(env, 'Delta');
    const db = openGroveDb(env, grove);
    try {
      const created = createGroveBackup({ groveId: grove.id, db, machineId: MACHINE, mycoHome: env.mycoHome });
      const fileName = path.basename(created.file_path);

      const preview = await previewGroveRestore({ groveId: grove.id, db, fileName, mycoHome: env.mycoHome });
      expect(preview?.ref.file_name).toBe(fileName);

      const outcome = restoreGroveBackup({ groveId: grove.id, db, fileName, mycoHome: env.mycoHome });
      expect(outcome?.ref.file_name).toBe(fileName);

      // Unknown file → null (handler turns this into 404).
      expect(restoreGroveBackup({ groveId: grove.id, db, fileName: 'nope__1.sql', mycoHome: env.mycoHome })).toBeNull();
    } finally {
      db.close();
    }
  });

  it('createGroveBackup writes into the canonical dir', () => {
    const grove = makeGrove(env, 'Epsilon');
    const db = openGroveDb(env, grove);
    try {
      const created = createGroveBackup({ groveId: grove.id, db, machineId: MACHINE, mycoHome: env.mycoHome });
      const canonical = resolveGroveBackupDir(grove.id, { mycoHome: env.mycoHome });
      expect(path.dirname(created.file_path)).toBe(canonical);
    } finally {
      db.close();
    }
  });
});
