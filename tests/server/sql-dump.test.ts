import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importTableDump } from '@myco/server/sql-dump.js';

it('imports provider NUL text, multiline literals and binary bytes across stream boundaries without interpreting literal punctuation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sql-dump-'));
  const file = path.join(root, 'export.sql');
  const db = new Database(':memory:');
  const body = 'x'.repeat(65531) + "🌱; 'quote'\n-- text /* more */\0tail";
  fs.writeFileSync(file, `CREATE TABLE content(id INTEGER PRIMARY KEY, body TEXT, bytes BLOB);\nINSERT INTO content VALUES(71, '${body.replaceAll("'", "''")}', X'00017f80ff');\n`);
  try {
    await importTableDump(db, file);
    expect(db.query('SELECT * FROM content').get()).toEqual({ id: 71, body, bytes: new Uint8Array([0, 1, 127, 128, 255]) });
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
