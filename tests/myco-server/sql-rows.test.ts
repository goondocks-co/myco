/**
 * The canonical reader of a row an export carries: which statements the splitter keeps under row retention, and
 * what one `INSERT` answers. Nothing else in the Worker reads a SQL literal, so the forms it refuses matter as much
 * as the ones it reads.
 */
import { expect, it } from 'bun:test';
import {
  endStatements, feedStatements, insertedRow, newStatementScan, sqlValue,
} from '@myco-server-worker/core/sql-statements.js';

const kept = (sql: string, tables: readonly string[]): string[] => {
  const scan = newStatementScan();
  const held: string[] = [];
  feedStatements(scan, sql, { rows: tables }, (statement) => held.push(statement.trim()));
  endStatements(scan, { rows: tables }, (statement) => held.push(statement.trim()));
  return held;
};

it('keeps only the row inserts into the tables it was asked for', () => {
  const sql = [
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE blobs (project_id TEXT, key TEXT, size INTEGER);',
    "INSERT INTO blobs VALUES('proj_1','aa',12);",
    "INSERT INTO events VALUES('proj_1','ev_1','a prompt naming INSERT INTO blobs VALUES(1)');",
    "INSERT INTO backups (id,key,size_bytes,sha256) VALUES('b1','backups/b1',4,'bb');",
    'DELETE FROM sqlite_sequence;',
  ].join('\n');
  const held = kept(sql, ['blobs', 'backups']);
  expect(held.map((statement) => statement.slice(0, 18))).toEqual(['INSERT INTO blobs ', 'INSERT INTO backup']);
});

it('reads the values of a row, and the columns where the export names them', () => {
  const row = insertedRow("INSERT INTO blobs VALUES('proj_1','aa',12);")!;
  expect([row.table, row.columns]).toEqual(['blobs', null]);
  expect(row.values).toEqual([{ kind: 'text', text: 'proj_1' }, { kind: 'text', text: 'aa' }, { kind: 'integer', integer: 12 }]);

  const named = insertedRow('INSERT INTO "backups" ("id", "key", size_bytes, sha256) VALUES (\'b1\', \'backups/b1\', 4, NULL);')!;
  expect([named.table, named.columns]).toEqual(['backups', ['id', 'key', 'size_bytes', 'sha256']]);
  expect(named.values[3]).toEqual({ kind: 'null' });
});

it('reads every literal form an export writes, and refuses what it cannot read', () => {
  expect(sqlValue("'a''b'")).toEqual({ kind: 'text', text: "a'b" });
  expect(sqlValue("'has, comma and ) bracket'")).toEqual({ kind: 'text', text: 'has, comma and ) bracket' });
  expect(sqlValue("X'0AfF'")).toEqual({ kind: 'blob', hex: '0aff' });
  expect(sqlValue('-9007199254740991')).toEqual({ kind: 'integer', integer: -9_007_199_254_740_991 });
  expect(sqlValue('1.5e3')).toEqual({ kind: 'real', real: 1500 });
  expect(sqlValue('NULL')).toEqual({ kind: 'null' });
  // An integer the export cannot represent, an unterminated literal, an expression and an empty member are refused.
  expect(sqlValue('9223372036854775807')).toBeNull();
  expect(sqlValue("'open")).toBeNull();
  expect(sqlValue("CAST(X'00' AS TEXT)")).toBeNull();
  expect(sqlValue('')).toBeNull();
});

it('refuses a statement whose form it does not read, rather than guessing a row', () => {
  for (const statement of [
    "INSERT INTO blobs VALUES('a'),('b');",
    "INSERT INTO other.blobs VALUES('a');",
    "INSERT INTO blobs SELECT * FROM staging;",
    "INSERT INTO blobs VALUES('a','b'",
    "UPDATE blobs SET size = 1;",
    "INSERT INTO blobs (key VALUES('a');",
  ]) {
    expect({ statement, row: insertedRow(statement) }).toEqual({ statement, row: null });
  }
});

it('reads a row whose text carries the punctuation of the grammar around it', () => {
  const row = insertedRow(`INSERT INTO blobs VALUES('proj_1','key with '') and , inside',7);`)!;
  expect(row.values).toEqual([
    { kind: 'text', text: 'proj_1' },
    { kind: 'text', text: "key with ') and , inside" },
    { kind: 'integer', integer: 7 },
  ]);
});

it('keeps row retention bounded, whatever the export puts before a statement', () => {
  // A run of comments says nothing about the form, and must not accumulate while it waits to be judged.
  const comments = `${'-- filler\n'.repeat(60_000)}`;
  const scanned = newStatementScan();
  const found: string[] = [];
  feedStatements(scanned, `${comments}INSERT INTO blobs VALUES('proj_1','cc',2);\n`, { rows: ['blobs'] }, (statement) => found.push(statement.trim()));
  endStatements(scanned, { rows: ['blobs'] }, (statement) => found.push(statement.trim()));
  expect(found.some((statement) => statement.endsWith("VALUES('proj_1','cc',2);"))).toBe(true);
  expect(JSON.stringify(scanned).length).toBeLessThan(2_048);

  const padding = 'x'.repeat(200_000);
  const sql = `INSERT INTO events VALUES('${padding}');\nINSERT INTO blobs VALUES('proj_1','aa',1);\n`;
  const scan = newStatementScan();
  const held: string[] = [];
  feedStatements(scan, sql, { rows: ['blobs'] }, (statement) => held.push(statement.trim()));
  endStatements(scan, { rows: ['blobs'] }, (statement) => held.push(statement.trim()));
  expect(held).toEqual(["INSERT INTO blobs VALUES('proj_1','aa',1);"]);
  expect(JSON.stringify(scan).length).toBeLessThan(2_048);
});
