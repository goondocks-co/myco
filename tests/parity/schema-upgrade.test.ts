import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { assertMigrationMutationDetected, assertUpgradeState, isLocalMigrationSqlFailure, referencedExistingTables, schemaObjects, seedReferencedTables } from './schema-upgrade.ts';

const trigger = `CREATE TRIGGER "next trigger" AFTER UPDATE ON "upgrade parent"
  BEGIN UPDATE "upgrade parent" SET label = 'migrated' WHERE id = NEW.id; END`;
const dropIndex = 'DROP INDEX [parent label index]';

function previousSchema(): Database {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE "upgrade parent" (id TEXT PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE "upgrade child" (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES "upgrade parent"(id));
    CREATE INDEX "parent label index" ON "upgrade parent"(label);`);
  return db;
}

it('resolves quoted trigger and dropped index owners, seeds FK children, and detects either missing statement', () => {
  const databases = [previousSchema(), previousSchema(), previousSchema()];
  try {
    const [complete, noTrigger, noDrop] = databases;
    for (const db of databases) {
      expect(referencedExistingTables(db, [trigger, dropIndex])).toEqual(['upgrade parent']);
      expect(referencedExistingTables(db, ["UPDATE `upgrade parent` SET label = 'upgrade child'"])).toEqual(['upgrade parent']);
      expect(() => referencedExistingTables(db, ['DROP INDEX [missing index]'])).toThrow('unsupported D1 upgrade fixture');
      expect(seedReferencedTables(db, [trigger, dropIndex])).toEqual(['upgrade parent', 'upgrade child']);
      expect(db.query('SELECT COUNT(*) AS n FROM "upgrade parent"').get()).toEqual({ n: 1 });
      expect(db.query('SELECT COUNT(*) AS n FROM "upgrade child"').get()).toEqual({ n: 1 });
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }
    complete.exec(`${trigger}; ${dropIndex}; UPDATE "upgrade parent" SET label = 'changed'`);
    noTrigger.exec(`${dropIndex}; UPDATE "upgrade parent" SET label = 'changed'`);
    noDrop.exec(`${trigger}; UPDATE "upgrade parent" SET label = 'changed'`);
    expect(complete.query('SELECT label FROM "upgrade parent"').get()).toEqual({ label: 'migrated' });
    expect(noTrigger.query('SELECT label FROM "upgrade parent"').get()).not.toEqual(complete.query('SELECT label FROM "upgrade parent"').get());
    const index = (db: Database) => db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'parent label index'").get();
    expect(index(complete)).toBeNull();
    expect(index(noDrop)).toEqual({ name: 'parent label index' });
  } finally { for (const db of databases) db.close(); }
});

it('counts an omitted prerequisite SQL rejection as a detected mutation', () => {
  const db = previousSchema();
  try {
    expect(() => db.exec('CREATE INDEX "next index" ON "next table"(id)')).toThrow('no such table');
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: no such table: next table'))).toBe(true);
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: not authorized: SQLITE_AUTH'))).toBe(false);
    expect(isLocalMigrationSqlFailure(new Error('spawn wrangler ENOENT'))).toBe(false);
  } finally { db.close(); }
});

it('requires an observed state mismatch after a local SQL rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-upgrade-mutation-'));
  const databaseFile = path.join(root, 'previous.sqlite');
  const db = new Database(databaseFile);
  try {
    db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('version', '1');
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY);
      INSERT INTO d1_migrations (id) VALUES (1);
      CREATE TABLE "upgrade parent" (id TEXT PRIMARY KEY);`);
    const actualSchema = schemaObjects(db);

    const sqlRefusal = new Error('wrangler d1 migrations apply exited 1: SQLITE_ERROR: no such table: next table');
    let verifications = 0;
    await expect(assertMigrationMutationDetected(
      async () => { throw sqlRefusal; },
      () => { verifications += 1; assertUpgradeState(databaseFile, 1, actualSchema, {}); },
    )).rejects.toBe(sqlRefusal);
    expect(verifications).toBe(1);

    await assertMigrationMutationDetected(
      async () => { throw sqlRefusal; },
      () => assertUpgradeState(databaseFile, 2, actualSchema, {}),
    );
    await assertMigrationMutationDetected(
      async () => { throw sqlRefusal; },
      () => assertUpgradeState(databaseFile, 1, [...actualSchema, { type: 'table', name: 'next table', sql: 'CREATE TABLE "next table" (id TEXT)' }], {}),
    );
    await expect(assertMigrationMutationDetected(
      async () => { throw sqlRefusal; },
      () => { throw new Error('unrelated D1 file read failure'); },
    )).rejects.toThrow('unrelated D1 file read failure');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
