import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function stampedVersion(db: Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
  ).get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function insertSession(db: Database, id: string, status: string): void {
  const now = epochSeconds();
  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, status, prompt_count, tool_count, created_at)
     VALUES (?, 'claude-code', ?, ?, 0, 0, ?)`,
  ).run(id, now, status, now);
}

/**
 * A vault frozen at v73: created at the current shape, then the new column
 * dropped and the version stamped back to 73, so the migration has real work.
 *
 * The 73 row must be inserted explicitly. A fresh install stamps only
 * SCHEMA_VERSION, so deleting everything above 73 would leave the table empty,
 * `getCurrentVersion` would read 0, and the whole chain would replay from the
 * v34 rescue floor — which creates tables from the live DDL, so the column
 * would already exist by the time this migration ran and the backfill would
 * silently no-op.
 */
function seedV73Vault(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'local');
  db.prepare('ALTER TABLE sessions DROP COLUMN final_mine_ok').run();
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(73, epochSeconds());
  return db;
}

describe('migrateV73ToV74 — sessions.final_mine_ok', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(74);
  });

  it('a fresh install already has the column', () => {
    const db = new Database(':memory:');
    createSchema(db);
    expect(columnNames(db, 'sessions').has('final_mine_ok')).toBe(true);
    db.close();
  });

  it('a v73 vault gains the column and reaches v74 on the next createSchema()', () => {
    const db = seedV73Vault();
    expect(columnNames(db, 'sessions').has('final_mine_ok')).toBe(false);

    createSchema(db);

    expect(columnNames(db, 'sessions').has('final_mine_ok')).toBe(true);
    expect(stampedVersion(db)).toBeGreaterThanOrEqual(74);
    db.close();
  });

  it('backfills already-completed sessions so existing trees stay pruneable', () => {
    const db = seedV73Vault();
    insertSession(db, 'done-1', 'completed');
    insertSession(db, 'live-1', 'active');

    createSchema(db);

    const done = db.prepare('SELECT final_mine_ok FROM sessions WHERE id = ?').get('done-1') as { final_mine_ok: number | null };
    const live = db.prepare('SELECT final_mine_ok FROM sessions WHERE id = ?').get('live-1') as { final_mine_ok: number | null };
    expect(done.final_mine_ok).toBe(1);
    // An in-flight session has no mining outcome yet — it must not be presumed mined.
    expect(live.final_mine_ok).toBeNull();
    db.close();
  });

  it('is idempotent — a second createSchema() does not error or re-backfill', () => {
    const db = seedV73Vault();
    insertSession(db, 'done-1', 'completed');
    createSchema(db);

    // A session that later completed WITHOUT a successful mine must stay 0 and
    // not be re-backfilled to 1 by a subsequent boot.
    db.prepare('UPDATE sessions SET final_mine_ok = 0 WHERE id = ?').run('done-1');

    expect(() => createSchema(db)).not.toThrow();

    const row = db.prepare('SELECT final_mine_ok FROM sessions WHERE id = ?').get('done-1') as { final_mine_ok: number | null };
    expect(row.final_mine_ok).toBe(0);
    db.close();
  });
});
