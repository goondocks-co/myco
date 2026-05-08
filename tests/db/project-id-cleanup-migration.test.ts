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

  // -------------------------------------------------------------------------
  // Multi-table backfill coverage. The base test only proves the
  // backfill branch on log_entries; v36 walks every table in
  // GROVE_PROJECT_SCOPED_TABLES, so we exercise representative shapes:
  //   * spores  — FK-free row-scoped sync table
  //   * plans   — FK-free row-scoped sync table
  //   * digest_extracts — INTEGER PRIMARY KEY surrogate
  //   * agent_runs / agent_turns — FK parent + child (the migration
  //     suspends FK enforcement; we assert orphans flow correctly).
  // -------------------------------------------------------------------------

  function seedAgent(db: Database, id: string): void {
    db.prepare(
      `INSERT INTO agents (id, name, created_at, updated_at)
       VALUES (?, ?, 1700000000, 1700000000)`,
    ).run(id, id);
  }

  it('backfills orphan project_id rows in spores/plans/digest_extracts to the single Grove id', () => {
    const db = freshDbAtV35();
    const goodId = createProjectId();
    seedAgent(db, 'agent-x');

    // spores: one good + one NULL + one path-string + one wrong-prefix.
    const insertSpore = (projectId: string | null, suffix: string) => {
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at)
         VALUES (?, ?, 'agent-x', 'note', ?, 1700000000)`,
      ).run(`s-${suffix}`, projectId, `body-${suffix}`);
    };
    insertSpore(goodId, 'a');
    insertSpore(null, 'b');
    insertSpore('/Users/chris/Repos/myco', 'c');
    insertSpore('', 'd');

    // plans: one good + one NULL.
    const insertPlan = (projectId: string | null, suffix: string) => {
      db.prepare(
        `INSERT INTO plans (id, project_id, logical_key, created_at)
         VALUES (?, ?, ?, 1700000000)`,
      ).run(`p-${suffix}`, projectId, `lk-${suffix}`);
    };
    insertPlan(goodId, 'good');
    insertPlan(null, 'orphan');

    // digest_extracts uses INTEGER PRIMARY KEY AUTOINCREMENT, but a
    // UNIQUE (project_id, agent_id, tier) index forces us to use a
    // different tier per row so the post-backfill rows (all stamped
    // with the same project_id) don't collide.
    const insertDigest = (projectId: string | null, content: string, tier: number) => {
      db.prepare(
        `INSERT INTO digest_extracts (project_id, agent_id, tier, content, generated_at)
         VALUES (?, 'agent-x', ?, ?, 1700000000)`,
      ).run(projectId, tier, content);
    };
    insertDigest(goodId, 'good', 5000);
    insertDigest(null, 'orphan', 2500);
    insertDigest('/legacy/path', 'pathy', 1000);

    runV36(db);

    // Every spore preserved, all stamped to goodId.
    const spores = db.prepare(
      'SELECT id, project_id FROM spores ORDER BY id',
    ).all() as Array<{ id: string; project_id: string }>;
    expect(spores).toHaveLength(4);
    for (const row of spores) {
      expect(row.project_id).toBe(goodId);
    }

    const plans = db.prepare(
      'SELECT id, project_id FROM plans ORDER BY id',
    ).all() as Array<{ id: string; project_id: string }>;
    expect(plans).toHaveLength(2);
    for (const row of plans) expect(row.project_id).toBe(goodId);

    const digests = db.prepare(
      'SELECT content, project_id FROM digest_extracts ORDER BY content',
    ).all() as Array<{ content: string; project_id: string }>;
    expect(digests).toHaveLength(3);
    for (const row of digests) expect(row.project_id).toBe(goodId);
  });

  it('backfills FK-related agent_runs and agent_turns even when child orphans reference parent orphans', () => {
    // agent_turns.run_id references agent_runs.id. The migration
    // suspends FK enforcement so the order of UPDATEs/DELETEs across
    // parent/child doesn't matter — the suspension is critical because
    // children can have orphan project_ids whose parents are also orphan.
    const db = freshDbAtV35();
    const goodId = createProjectId();
    seedAgent(db, 'agent-x');

    const insertRun = (id: string, projectId: string | null) => {
      db.prepare(
        `INSERT INTO agent_runs (id, project_id, agent_id, status)
         VALUES (?, ?, 'agent-x', 'pending')`,
      ).run(id, projectId);
    };
    const insertTurn = (runId: string, projectId: string | null, n: number) => {
      db.prepare(
        `INSERT INTO agent_turns (project_id, run_id, agent_id, turn_number, tool_name)
         VALUES (?, ?, 'agent-x', ?, 'tool')`,
      ).run(projectId, runId, n);
    };

    insertRun('run-good', goodId);
    insertRun('run-null', null);
    insertRun('run-path', '/Users/chris/Repos/myco');
    insertTurn('run-good', goodId, 1);
    insertTurn('run-null', null, 1);     // both project_id and parent run are orphaned
    insertTurn('run-path', '', 2);       // empty-string project_id, orphan parent

    runV36(db);

    // Every parent + every child preserved, all stamped to goodId.
    const runs = db.prepare(
      'SELECT id, project_id FROM agent_runs ORDER BY id',
    ).all() as Array<{ id: string; project_id: string }>;
    expect(runs).toHaveLength(3);
    for (const row of runs) expect(row.project_id).toBe(goodId);

    const turns = db.prepare(
      'SELECT run_id, project_id FROM agent_turns ORDER BY turn_number, run_id',
    ).all() as Array<{ run_id: string; project_id: string }>;
    expect(turns).toHaveLength(3);
    for (const row of turns) expect(row.project_id).toBe(goodId);
  });

  it('deletes orphans on every backfill table when multiple Grove ids exist', () => {
    // Mirrors the existing log_entries multi-Grove case but for two
    // additional tables — proves the "groveIds.length > 1 → DELETE"
    // branch fires across the loop, not just for log_entries.
    const db = freshDbAtV35();
    const idA = createProjectId();
    const idB = createProjectId();
    seedAgent(db, 'agent-x');

    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at)
       VALUES ('s-A', ?, 'agent-x', 'n', 'a', 1)`,
    ).run(idA);
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at)
       VALUES ('s-B', ?, 'agent-x', 'n', 'b', 1)`,
    ).run(idB);
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at)
       VALUES ('s-orphan', NULL, 'agent-x', 'n', 'o', 1)`,
    ).run();

    db.prepare(
      `INSERT INTO plans (id, project_id, logical_key, created_at) VALUES ('p-A', ?, 'lk', 1)`,
    ).run(idA);
    db.prepare(
      `INSERT INTO plans (id, project_id, logical_key, created_at) VALUES ('p-B', ?, 'lk2', 1)`,
    ).run(idB);
    db.prepare(
      `INSERT INTO plans (id, project_id, logical_key, created_at) VALUES ('p-orphan', NULL, 'lk3', 1)`,
    ).run();

    runV36(db);

    const spores = db.prepare('SELECT id FROM spores ORDER BY id').all() as Array<{ id: string }>;
    expect(spores.map((r) => r.id).sort()).toEqual(['s-A', 's-B'].sort());
    const plans = db.prepare('SELECT id FROM plans ORDER BY id').all() as Array<{ id: string }>;
    expect(plans.map((r) => r.id).sort()).toEqual(['p-A', 'p-B'].sort());
  });
});
