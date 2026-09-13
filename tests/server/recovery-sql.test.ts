import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRecoverySql } from '@myco/server/recovery-sql.js';

it('preserves exact typed values, rowids, sequence high-water and FTS through bounded recovery SQL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recovery-sql-'));
  const file = path.join(root, 'source.sqlite');
  const source = new Database(file, { safeIntegers: true });
  const recovered = new Database(':memory:', { safeIntegers: true });
  const text = "Recovery 🌱 'quoted';\0tail\n".repeat(9000);
  const bytes = new Uint8Array(512 * 1024).map((_, index) => index % 256);
  try {
    source.exec(`CREATE TABLE parents(id INTEGER PRIMARY KEY);
      CREATE TABLE children(id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES parents(id), body TEXT, payload BLOB, untyped);
      INSERT INTO parents VALUES(9223372036854775806);
      INSERT INTO children(id) VALUES(71); DELETE FROM children;
      CREATE VIRTUAL TABLE children_fts USING fts5(body,content='children',content_rowid='id');
      CREATE TRIGGER child_update AFTER UPDATE ON children BEGIN
        INSERT INTO children_fts(children_fts,rowid,body) VALUES('delete',old.id,old.body);
        INSERT INTO children_fts(rowid,body) VALUES(new.id,new.body);
      END;`);
    source.query('INSERT INTO children VALUES(42,9223372036854775806,?,?,1.0)').run(text, bytes);
    source.exec("INSERT INTO children_fts(children_fts) VALUES('rebuild')");
    const output = path.join(root, 'recovery.sql');
    const report = writeRecoverySql(file, output);
    expect(report.rows).toBe(2);
    const sql = fs.readFileSync(output, 'utf8');
    expect(Math.max(...sql.split(';\n').map((statement) => Buffer.byteLength(statement)))).toBeLessThan(90_000);
    recovered.exec('PRAGMA foreign_keys=ON; BEGIN');
    recovered.exec(sql);
    recovered.exec('COMMIT');
    expect(recovered.query('SELECT *,typeof(untyped) AS stored_type FROM children').get())
      .toEqual({ id: 42n, parent_id: 9223372036854775806n, body: text, payload: bytes, untyped: 1, stored_type: 'real' });
    expect(recovered.query("SELECT rowid FROM children_fts WHERE children_fts MATCH 'Recovery'").get()).toEqual({ rowid: 42n });
    recovered.exec("UPDATE children SET body='Updated finding' WHERE id=42");
    expect(recovered.query("SELECT rowid FROM children_fts WHERE children_fts MATCH 'Updated'").get()).toEqual({ rowid: 42n });
    expect(recovered.query('INSERT INTO children(body) VALUES(\'next\') RETURNING id').get()).toEqual({ id: 72n });
    expect(recovered.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(source.query('SELECT body,payload FROM children').get()).toEqual({ body: text, payload: bytes });
    expect(() => writeRecoverySql(file, output)).toThrow('destination already exists');
  } finally { recovered.close(); source.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses cyclic dependencies before publishing an import file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recovery-cycle-'));
  const file = path.join(root, 'source.sqlite');
  const source = new Database(file);
  try {
    source.exec('CREATE TABLE a(id INTEGER PRIMARY KEY,b INTEGER REFERENCES b(id)); CREATE TABLE b(id INTEGER PRIMARY KEY,a INTEGER REFERENCES a(id));');
    expect(() => writeRecoverySql(file, path.join(root, 'recovery.sql'))).toThrow('cyclic table dependencies');
    expect(fs.readdirSync(root)).toEqual(['source.sqlite']);
  } finally { source.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
