import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { createBackup } from '@myco/backup/engine.js';
import { run as restoreBackupCli } from '@myco/cli/restore-backup.js';

const MACHINE = 'testmachine';

interface Env {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  cleanup: () => void;
}

function setup(): Env {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rbcli-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const prev = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();
  const grove = createGrove('Solo', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const db = openDatabase(resolveGroveDbPath(grove.id, mycoHome));
  createSchema(db);
  db.close();
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

describe('__restore-backup child command', () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => env.cleanup());

  it('writes a valid RestoreResult JSON to the output path', async () => {
    const dbPath = resolveGroveDbPath(env.grove.id, env.mycoHome);
    const db = openDatabase(dbPath);
    let backupPath: string;
    try {
      backupPath = createBackup(db, path.join(env.workDir, 'backups'), MACHINE);
    } finally {
      db.close();
    }
    const outPath = path.join(env.workDir, 'result.json');

    await restoreBackupCli([dbPath, backupPath, outPath]);

    const result = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(Array.isArray(result.tables)).toBe(true);
    expect(typeof result.total_restored).toBe('number');
    expect(typeof result.total_skipped).toBe('number');
  });

  it('throws on missing arguments', async () => {
    await expect(restoreBackupCli(['only-one-arg'])).rejects.toThrow();
  });
});
