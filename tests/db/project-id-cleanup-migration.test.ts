import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import { createProjectId } from '@myco/grove/ids.js';

/**
 * v36 sweeps orphan `project_id` rows left from the dual-namespace bug
 * the Grove migration introduced. Verify each shape (NULL, empty,
 * path-string, wrong-prefix) gets removed and Grove-era rows survive,
 * including for canopy tables that aren't in GROVE_PROJECT_SCOPED_TABLES.
 */
describe('migration v36 — project_id orphan cleanup', () => {
  function freshDbAtV35(): Database {
    const db = new Database(':memory:');
    createSchema(db);
    // Roll back the version so we can re-run v36 in isolation.
    db.prepare('UPDATE schema_version SET version = 35 WHERE version = ?').run(SCHEMA_VERSION);
    return db;
  }

  function runV36(db: Database): void {
    const migration = MIGRATIONS.find((m) => m.version === 36)!;
    migration.migrate(db, 'local');
  }

  function insertCanopyRow(db: Database, projectId: string, path: string): void {
    db.prepare(
      `INSERT INTO canopy_entries (
         project_id, machine_id, path, content_hash, size_bytes,
         token_estimate, line_count, mechanical_updated_at
       ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, path, 'h'.repeat(64), 100, 25, 5, 1700000000);
  }

  it('removes path-string project_id rows from canopy_entries (the active bug)', () => {
    const db = freshDbAtV35();
    const goodId = createProjectId();
    insertCanopyRow(db, goodId, 'src/keep.ts');
    insertCanopyRow(db, '/Users/chris/Repos/myco', 'src/path.ts');
    // The column is NOT NULL on canopy_entries, so NULL/empty can't exist
    // there in practice — only the legacy path-derived id ever reached it.

    runV36(db);

    const rows = db.prepare('SELECT project_id, path FROM canopy_entries').all() as Array<{ project_id: string; path: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(goodId);
    expect(rows[0].path).toBe('src/keep.ts');
  });

  it('backfills NULL/orphan log_entries to the single Grove project id (audit-trail preservation)', () => {
    const db = freshDbAtV35();
    const goodId = createProjectId();
    const insertLog = (projectId: string | null) => {
      db.prepare(
        `INSERT INTO log_entries (timestamp, level, kind, component, message, project_id)
         VALUES ('2026-05-06T00:00:00Z', 'info', 'k', 'c', 'm', ?)`,
      ).run(projectId);
    };
    insertLog(goodId);
    insertLog(null);
    insertLog('');
    insertLog('/some/path');

    runV36(db);

    // Audit-trail rows aren't deleted — they're updated to the only
    // Grove id present in the table, preserving runtime telemetry that
    // the daemon emitted before the writer-context fix.
    const survivors = db.prepare('SELECT project_id FROM log_entries').all() as Array<{ project_id: string }>;
    expect(survivors).toHaveLength(4);
    for (const row of survivors) {
      expect(row.project_id).toBe(goodId);
    }
  });

  it('deletes orphan log_entries when multiple Grove ids exist (cannot infer)', () => {
    const db = freshDbAtV35();
    const goodA = createProjectId();
    const goodB = createProjectId();
    const insertLog = (projectId: string | null) => {
      db.prepare(
        `INSERT INTO log_entries (timestamp, level, kind, component, message, project_id)
         VALUES ('2026-05-06T00:00:00Z', 'info', 'k', 'c', 'm', ?)`,
      ).run(projectId);
    };
    insertLog(goodA);
    insertLog(goodB);
    insertLog(null);
    insertLog('/some/path');

    runV36(db);

    const survivors = db.prepare('SELECT project_id FROM log_entries ORDER BY project_id').all() as Array<{ project_id: string }>;
    expect(survivors).toHaveLength(2);
    expect(survivors.map((r) => r.project_id).sort()).toEqual([goodA, goodB].sort());
  });

  it('removes pending team_outbox rows whose payload carries a bad project_id', () => {
    const db = freshDbAtV35();
    const goodId = createProjectId();
    const insertOutbox = (projectId: string | null, sentAt: number | null) => {
      db.prepare(
        `INSERT INTO team_outbox (table_name, row_id, payload, machine_id, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'spores',
        `row-${Math.random()}`,
        JSON.stringify({ project_id: projectId, payload: 'x' }),
        'local',
        1700000000,
        sentAt,
      );
    };
    insertOutbox(goodId, null);                    // good pending — keep
    insertOutbox(null, null);                      // bad pending — drop
    insertOutbox('/path/string', null);            // bad pending — drop
    insertOutbox('', null);                        // bad pending — drop
    insertOutbox(null, 1700000000);                // bad already sent — keep (24h prune handles it)

    runV36(db);

    const remaining = db.prepare(
      `SELECT json_extract(payload, '$.project_id') AS pid, sent_at FROM team_outbox`,
    ).all() as Array<{ pid: string | null; sent_at: number | null }>;
    expect(remaining).toHaveLength(2);
    const pending = remaining.find((r) => r.sent_at === null);
    const sent = remaining.find((r) => r.sent_at !== null);
    expect(pending?.pid).toBe(goodId);
    expect(sent?.pid).toBeNull();
  });

  it('preserves rows in tables that lack a project_id column (no-op)', () => {
    const db = freshDbAtV35();
    // schema_version itself has no project_id; the migration must not touch it.
    const before = db.prepare('SELECT COUNT(*) as n FROM schema_version').get() as { n: number };
    runV36(db);
    const after = db.prepare('SELECT COUNT(*) as n FROM schema_version').get() as { n: number };
    expect(after.n).toBeGreaterThanOrEqual(before.n);
  });

  it('stamps schema_version to 36', () => {
    const db = freshDbAtV35();
    runV36(db);
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(36);
  });
});
