import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyMigrationPending, LegacyMigrationUnreadable } from '@myco/member/legacy-migration.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { withLegacyBinaryTraps } from '../helpers/legacy-migration-fixture.js';

let root: string;
let home: string;
let userHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-migration-state-'));
  home = path.join(root, 'member-home');
  userHome = path.join(root, 'operator');
  previousHome = process.env.HOME;
  process.env.HOME = userHome;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function vault(mycoHome = home, grove = 'one'): string {
  const file = path.join(mycoHome, 'groves', grove, 'myco.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try { db.run('CREATE TABLE sessions (body TEXT)'); db.run("INSERT INTO sessions VALUES ('retained')"); } finally { db.close(); }
  return file;
}

function backup(file: string, metadata = false, recordHome = home): void {
  const stat = fs.statSync(file);
  const evidence = metadata ? { size: stat.size, mtimeMs: stat.mtimeMs } : { digest: readVaultContent(file).digest };
  const record = path.join(recordHome, 'member', 'cutover.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ backups: { [file]: evidence } }), { mode: 0o600 });
}

it('defers an unmigrated vault and clears when its cutover content digest matches', () => {
  const file = vault();
  expect(legacyMigrationPending(home)).toBe(true);
  backup(file);
  expect(legacyMigrationPending(home)).toBe(false);
  const db = new Database(file);
  try { db.run("INSERT INTO sessions VALUES ('new capture')"); } finally { db.close(); }
  expect(legacyMigrationPending(home)).toBe(true);
});

it('accepts matching size and mtime evidence and defers a new vault', () => {
  backup(vault(), true);
  expect(legacyMigrationPending(home)).toBe(false);
  vault(home, 'new');
  expect(legacyMigrationPending(home)).toBe(true);
});

it('checks the default home and accepts its evidence in either cutover home', () => {
  const defaultHome = path.join(userHome, '.myco');
  const file = vault(defaultHome);
  expect(legacyMigrationPending(home)).toBe(true);
  backup(file);
  expect(legacyMigrationPending(home)).toBe(false);
  fs.unlinkSync(path.join(home, 'member', 'cutover.json'));
  backup(file, false, defaultHome);
  expect(legacyMigrationPending(home)).toBe(false);
});

it('names an unreadable cutover record instead of treating it as completion', () => {
  const file = vault();
  backup(file);
  const record = path.join(home, 'member', 'cutover.json');
  fs.writeFileSync(record, '{');
  expect(() => legacyMigrationPending(home)).toThrow(LegacyMigrationUnreadable);
  expect(() => legacyMigrationPending(home)).toThrow(`cannot read ${record}`);
});

it.skipIf(process.platform === 'win32')('never executes a managed or PATH binary while observing legacy migration', async () => {
  vault();
  await withLegacyBinaryTraps(home, userHome, async (marker) => {
    expect(legacyMigrationPending(home)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
