import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import type { Database } from 'bun:sqlite';

function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS cnt FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
  ).get(tableName) as { cnt: number };
  return row.cnt > 0;
}

function indexExists(db: Database, indexName: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS cnt FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(indexName) as { cnt: number };
  return row.cnt > 0;
}

describe('release provenance schema', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  it('installs release provenance tables on a fresh database', () => {
    createSchema(db);

    expect(tableExists(db, 'knowledge_git_provenance')).toBe(true);
    expect(tableExists(db, 'knowledge_release_state')).toBe(true);
    expect(indexExists(db, 'idx_knowledge_git_provenance_project_captured')).toBe(true);
    expect(indexExists(db, 'idx_knowledge_release_state_record')).toBe(true);
  });

  it('migrates a v40 database to release provenance schema', () => {
    createSchema(db);
    db.prepare(`DROP TABLE knowledge_release_state`).run();
    db.prepare(`DROP TABLE knowledge_git_provenance`).run();
    db.prepare(`DELETE FROM schema_version WHERE version = ?`).run(SCHEMA_VERSION);
    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(40, 1000);

    createSchema(db);

    expect(tableExists(db, 'knowledge_git_provenance')).toBe(true);
    expect(tableExists(db, 'knowledge_release_state')).toBe(true);
    const row = db.prepare(
      `SELECT MAX(version) AS v FROM schema_version`,
    ).get() as { v: number };
    expect(row.v).toBe(SCHEMA_VERSION);
  });
});
