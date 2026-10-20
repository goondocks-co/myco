import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { UpgradeStateMismatchError, assertMigrationMutationDetected, assertUpgradeState, firstObservableOmission, isLocalMigrationSqlFailure, referencedExistingTables, schemaObjects, seedReferencedTables } from './schema-upgrade.ts';

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
    const omitted = 'CREATE TABLE "next table" (id TEXT PRIMARY KEY)';
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: no such table: next table'), omitted)).toBe(true);
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: no such table: different table'), omitted)).toBe(false);
    // As Wrangler prints it: the store's code after the name, in terminal colours.
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: \u001b[31m✘ \u001b[1mno such table: next table: SQLITE_ERROR\u001b[0m'), omitted)).toBe(true);
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: SQLITE_ERROR: near "X": syntax error'), omitted)).toBe(false);
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: not authorized: SQLITE_AUTH'), omitted)).toBe(false);
    expect(isLocalMigrationSqlFailure(new Error('spawn wrangler ENOENT'), omitted)).toBe(false);
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: no such column: [new column]'), 'ALTER TABLE "upgrade parent" ADD COLUMN [new column] TEXT')).toBe(true);
    expect(isLocalMigrationSqlFailure(new Error('wrangler d1 migrations apply exited 1: no such index: next index'), 'CREATE INDEX [next index] ON "upgrade parent"(id)')).toBe(true);
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

    const omitted = 'CREATE TABLE "next table" (id TEXT PRIMARY KEY)';
    const sqlRefusal = new Error('wrangler d1 migrations apply exited 1: SQLITE_ERROR: no such table: next table');
    let verifications = 0;
    await expect(assertMigrationMutationDetected(
      omitted,
      async () => { throw sqlRefusal; },
      () => { verifications += 1; assertUpgradeState(databaseFile, 1, actualSchema, {}); },
    )).rejects.toBe(sqlRefusal);
    expect(verifications).toBe(1);

    await assertMigrationMutationDetected(
      omitted,
      async () => { throw sqlRefusal; },
      () => assertUpgradeState(databaseFile, 2, actualSchema, {}),
    );
    await assertMigrationMutationDetected(
      omitted,
      async () => { throw sqlRefusal; },
      () => assertUpgradeState(databaseFile, 1, [...actualSchema, { type: 'table', name: 'next table', sql: 'CREATE TABLE "next table" (id TEXT)' }], {}),
    );
    for (const unrelated of [
      new Error('wrangler d1 migrations apply exited 1: SQLITE_ERROR: near "X": syntax error'),
      new Error('wrangler d1 migrations apply exited 1: no such table: different table'),
    ]) {
      await expect(assertMigrationMutationDetected(
        omitted,
        async () => { throw unrelated; },
        () => assertUpgradeState(databaseFile, 2, actualSchema, {}),
      )).rejects.toBe(unrelated);
    }
    await expect(assertMigrationMutationDetected(
      omitted,
      async () => { throw sqlRefusal; },
      () => { throw new Error('unrelated D1 file read failure'); },
    )).rejects.toThrow('unrelated D1 file read failure');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('tries later statements when an earlier omission is invisible to seeded rows', async () => {
  const attempt = async (statements: readonly string[], tried: number[]): Promise<number> => {
    const seeded = (): Database => {
      const db = previousSchema();
      db.exec(`INSERT INTO "upgrade parent" (id, label) VALUES ('present', 'original')`);
      return db;
    };
    const expected = seeded();
    try {
      for (const statement of statements) expected.exec(statement);
      const expectedState = JSON.stringify({ schema: schemaObjects(expected), rows: expected.query('SELECT * FROM "upgrade parent"').all() });
      return await firstObservableOmission(statements, async (omitted, index) => {
        tried.push(index);
        const candidate = seeded();
        try {
          await assertMigrationMutationDetected(
            omitted,
            async () => { for (const [statementIndex, statement] of statements.entries()) if (statementIndex !== index) candidate.exec(statement); },
            () => {
              const actualState = JSON.stringify({ schema: schemaObjects(candidate), rows: candidate.query('SELECT * FROM "upgrade parent"').all() });
              if (actualState !== expectedState) throw new UpgradeStateMismatchError('seeded fixture changed');
            },
          );
        } finally { candidate.close(); }
      });
    } finally { expected.close(); }
  };

  const noop = `UPDATE "upgrade parent" SET label = 'unused' WHERE id = 'absent'`;
  const triedObservable: number[] = [];
  expect(await attempt([noop, 'CREATE INDEX "next index" ON "upgrade parent"(label)'], triedObservable)).toBe(1);
  expect(triedObservable).toEqual([0, 1]);

  const triedNoops: number[] = [];
  await expect(attempt([noop, `UPDATE "upgrade parent" SET label = 'still unused' WHERE id = 'missing'`], triedNoops))
    .rejects.toThrow('no statement of the latest step changes the seeded fixture; seed data it touches');
  expect(triedNoops).toEqual([0, 1]);
});

it('registers the reporter-order and writer-revision upgrade as the latest schema step', async () => {
  const { SCHEMA_STEPS } = await import('@myco-server-worker/db/schema.js');
  expect(SCHEMA_STEPS.at(-1)!.version).toBe(92);
  const db = new Database(':memory:');
  try {
    for (const step of SCHEMA_STEPS) for (const sql of step.statements) db.exec(sql);
    for (const [table, column] of [
      ['knowledge_git_provenance', 'event_id'], ['deployment_settings', 'write_id'],
      ['worker_model_catalogs', 'observed_order'], ['runner_model_catalogs', 'observed_order'], ['runner_update_reports', 'observed_order'],
    ]) expect((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column)).toBe(true);
  } finally { db.close(); }
});
