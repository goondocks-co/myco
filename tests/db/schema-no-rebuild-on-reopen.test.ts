import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from '@myco/db/schema.js';

const now = 1_780_346_900;

function seedRawActivity(db: Database): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, created_at)
     VALUES ('sess-reopen', 'codex', ?, ?)`,
  ).run(now, now);
  const batch = db.prepare(
    `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
     VALUES ('sess-reopen', 1, ?, ?, 'active')`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO activities (
       session_id, prompt_batch_id, tool_name, tool_input, file_path,
       timestamp, created_at
     ) VALUES ('sess-reopen', ?, 'Grep', 'needle', 'a.ts', ?, ?)`,
  ).run(Number(batch.lastInsertRowid), now, now);
}

describe('createSchema warm reopen', () => {
  it('does not rebuild FTS on a warm reopen once sync triggers exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-schema-reopen-'));
    const dbPath = join(dir, 'myco.db');

    try {
      let db = new Database(dbPath);
      createSchema(db, 'test-machine');
      seedRawActivity(db);
      db.close();

      db = new Database(dbPath);
      const rebuilds: string[] = [];
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (/_fts\)\s*VALUES\('rebuild'\)/i.test(sql)) rebuilds.push(sql);
        return prepare(sql);
      }) as typeof db.prepare;

      createSchema(db, 'test-machine');
      expect(rebuilds).toHaveLength(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
