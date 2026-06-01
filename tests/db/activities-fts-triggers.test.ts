import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '@myco/db/schema.js';

const now = 1_780_346_900;

function seedActivityParents(db: Database): number {
  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, created_at)
     VALUES ('sess-activities-fts', 'codex', ?, ?)`,
  ).run(now, now);
  const batch = db.prepare(
    `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
     VALUES ('sess-activities-fts', 1, ?, ?, 'active')`,
  ).run(now, now);
  return Number(batch.lastInsertRowid);
}

function insertRawActivity(
  db: Database,
  batchId: number,
  fields: { id: number; tool_name: string; tool_input: string; file_path: string },
): void {
  db.prepare(
    `INSERT INTO activities (
       id, session_id, prompt_batch_id, tool_name, tool_input, file_path,
       timestamp, created_at
     ) VALUES (?, 'sess-activities-fts', ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    batchId,
    fields.tool_name,
    fields.tool_input,
    fields.file_path,
    now,
    now,
  );
}

function activityFtsHits(db: Database, query: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM activities_fts WHERE activities_fts MATCH ?`,
  ).get(query) as { n: number }).n;
}

describe('activities_fts sync triggers', () => {
  it('creates the activities_fts_ai/au/ad triggers', () => {
    const db = new Database(':memory:');
    createSchema(db, 'test-machine');

    const names = (db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'activities_fts_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>).map((row) => row.name);

    expect(names).toEqual(['activities_fts_ad', 'activities_fts_ai', 'activities_fts_au']);
    db.close();
  });

  it('keeps activities_fts in sync incrementally on raw insert/update/delete', () => {
    const db = new Database(':memory:');
    createSchema(db, 'test-machine');
    const batchId = seedActivityParents(db);

    insertRawActivity(db, batchId, {
      id: 1,
      tool_name: 'Grep',
      tool_input: 'needle',
      file_path: 'a.ts',
    });
    expect(activityFtsHits(db, 'needle')).toBe(1);

    db.prepare(`UPDATE activities SET tool_input = 'haystack' WHERE id = 1`).run();
    expect(activityFtsHits(db, 'needle')).toBe(0);
    expect(activityFtsHits(db, 'haystack')).toBe(1);

    db.prepare(`DELETE FROM activities WHERE id = 1`).run();
    expect(activityFtsHits(db, 'haystack')).toBe(0);
    db.close();
  });
});
