import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importTableDump } from '@myco/server/sql-dump.js';
import { buildSnapshotDatabase } from '@myco/server/recovery-snapshot.js';
import { SCHEMA_QUERY, schemaObjects } from '@myco/server/recovery-schema.js';

function work() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sql-contract-'));
  const outside = path.join(root, 'outside.sqlite');
  const external = new Database(outside);
  external.exec('CREATE TABLE marker(value TEXT)');
  external.run("INSERT INTO marker VALUES ('untouched')");
  external.close();
  const marker = (): string | undefined => {
    const db = new Database(outside, { readonly: true });
    try { return db.query<{ value: string }, []>('SELECT value FROM marker').get()?.value; } finally { db.close(); }
  };
  const importInto = async (sql: string) => {
    const file = path.join(root, `dump-${Math.random().toString(36).slice(2)}.sql`);
    fs.writeFileSync(file, sql);
    const db = new Database(path.join(root, `built-${Math.random().toString(36).slice(2)}.sqlite`), { create: true });
    try { await importTableDump(db, file); return db; } catch (error) { db.close(); throw error; }
  };
  return { root, outside, marker, importInto, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); } };
}

it('imports the provider dump forms, keeping comments, literals, NUL, CRLF and the sequence high-water mark', async () => {
  const w = work();
  try {
    const db = await w.importInto([
      'PRAGMA defer_foreign_keys=TRUE;',
      'CREATE TABLE "rows" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, raw BLOB);',
      '-- a leading comment; with a semicolon',
      '/* a block comment; too */',
      `INSERT INTO "rows" ("id","body","raw") VALUES(3,'line; one\r\nquoted ''🌱'' /* text */ -- still text',X'00ff');`,
      `INSERT INTO "rows" ("id","body","raw") VALUES(4,'nul\0inside',NULL);`,
      'DELETE FROM sqlite_sequence;',
      `INSERT INTO sqlite_sequence VALUES('rows',71);`,
    ].join('\n'));
    try {
      expect(db.query<{ body: string }, []>('SELECT body FROM "rows" WHERE id = 3').get()!.body).toBe("line; one\r\nquoted '🌱' /* text */ -- still text");
      expect(db.query<{ body: string }, []>('SELECT body FROM "rows" WHERE id = 4').get()!.body).toBe('nul\0inside');
      expect(db.query<{ raw: Uint8Array }, []>('SELECT raw FROM "rows" WHERE id = 3').get()!.raw).toEqual(new Uint8Array([0, 255]));
      expect(db.query("INSERT INTO \"rows\"(body) VALUES('next') RETURNING id").get()).toEqual({ id: 72 });
    } finally { db.close(); }
  } finally { w.cleanup(); }
});

it('refuses ATTACH, transaction control, other pragmas and schema-qualified targets, leaving an outside database untouched', async () => {
  const w = work();
  try {
    const head = 'CREATE TABLE "rows" (id INTEGER PRIMARY KEY);\n';
    const cases: Array<[string, string]> = [
      ['ATTACH', `ATTACH DATABASE '${w.outside}' AS other;\nUPDATE other.marker SET value = 'changed by staging';`],
      ['BEGIN', 'BEGIN TRANSACTION;'],
      ['COMMIT', 'COMMIT;'],
      ['PRAGMA', 'PRAGMA journal_mode=WAL;'],
      ['UPDATE', "UPDATE \"rows\" SET id = 2;"],
      ['DROP', 'DROP TABLE "rows";'],
      ['CREATE', 'CREATE TRIGGER t AFTER INSERT ON "rows" BEGIN SELECT 1; END;'],
      ['DELETE', 'DELETE FROM "rows";'],
    ];
    for (const [token, sql] of cases) {
      await expect(w.importInto(head + sql)).rejects.toThrow(`recovery SQL import refuses ${token} in an ordinary-table export`);
      expect(w.marker()).toBe('untouched');
    }
    // A statement that names another schema is refused even in an allowed form.
    await expect(w.importInto(`${head}INSERT INTO other.marker VALUES ('changed by staging');`)).rejects.toThrow('naming another schema: other');
    expect(w.marker()).toBe('untouched');
    // Text after a complete statement never executes.
    await expect(w.importInto(`${head}INSERT INTO "rows" VALUES (1); ATTACH DATABASE '${w.outside}' AS other;`)).rejects.toThrow('recovery SQL import refuses ATTACH in an ordinary-table export');
    expect(w.marker()).toBe('untouched');
  } finally { w.cleanup(); }
});

it('refuses a captured schema object whose statement disagrees with it, and never runs a tail after it', async () => {
  const w = work();
  try {
    const source = new Database(path.join(w.root, 'source.sqlite'), { create: true });
    source.exec('CREATE TABLE "rows" (id INTEGER PRIMARY KEY, body TEXT)');
    source.exec('CREATE INDEX IF NOT EXISTS idx_rows_body ON "rows" (body)');
    const schema = schemaObjects.parse(source.query(SCHEMA_QUERY).all());
    source.close();
    const dump = path.join(w.root, 'schema-dump.sql');
    fs.writeFileSync(dump, 'CREATE TABLE "rows" (id INTEGER PRIMARY KEY, body TEXT);\n');

    const built = path.join(w.root, 'built.sqlite');
    await buildSnapshotDatabase(built, dump, schema);
    expect(fs.existsSync(built)).toBe(true);

    const injected = schema.map((row) => (row.type === 'index'
      ? { ...row, sql: `${row.sql}; ATTACH DATABASE '${w.outside}' AS other; UPDATE other.marker SET value = 'changed by schema'` }
      : row));
    fs.rmSync(built);
    await expect(buildSnapshotDatabase(built, dump, injected)).rejects.toThrow('exported database schema does not match its source');
    expect(w.marker()).toBe('untouched');

    const mislabelled = schema.map((row) => (row.type === 'index' ? { ...row, type: 'trigger' as const } : row));
    fs.rmSync(built, { force: true });
    await expect(buildSnapshotDatabase(built, dump, mislabelled)).rejects.toThrow('does not declare a trigger');

    const renamed = schema.map((row) => (row.type === 'index' ? { ...row, name: 'idx_other' } : row));
    fs.rmSync(built, { force: true });
    await expect(buildSnapshotDatabase(built, dump, renamed)).rejects.toThrow('names idx_rows_body');
    expect(w.marker()).toBe('untouched');
  } finally { w.cleanup(); }
});
