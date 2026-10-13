import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupVault } from '@myco/member/legacy-backup.js';

it('copies committed vault rows that exist only in uncheckpointed WAL frames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-wal-'));
  const source = path.join(root, 'source.db');
  const dest = path.join(root, 'backup.db');
  const writer = new Database(source);
  try {
    writer.run('PRAGMA journal_mode = WAL');
    writer.run('PRAGMA wal_autocheckpoint = 0');
    writer.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)');
    writer.run('PRAGMA wal_checkpoint(TRUNCATE)');
    writer.run("INSERT INTO sessions VALUES ('wal-only', 'durable history')");
    expect(fs.statSync(source + '-wal').size).toBeGreaterThan(0);
    backupVault(source, dest);
    const copied = new Database(dest, { readonly: true });
    try {
      expect(copied.query('SELECT * FROM sessions').all()).toEqual([{ id: 'wal-only', title: 'durable history' }]);
    } finally { copied.close(); }
  } finally {
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
