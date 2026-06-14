/**
 * Outbox project-membership gate.
 *
 * A team-sync outbox row is eligible iff its project_id is an explicit team
 * member (a row in team_sync_membership). This exercises all three enqueue
 * paths gated on membership:
 *   1. syncRow (live write path) skips non-member rows.
 *   2. backfillRows (startup/unsynced sweep) excludes non-member project rows
 *      while still carrying machine-scoped (team_members) self-rows.
 *   3. the AFTER DELETE triggers (gated in Task 1) journal a delete op only for
 *      member projects.
 * And purgeNonMemberOutbox self-heals historical bloat without ever touching
 * machine-scoped self-rows (project_id IS NULL).
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '@myco/db/schema.js';
import { withDatabase, getDatabase } from '@myco/db/client.js';
import { setTeamSyncEnabled, setProjectSyncMembership } from '@myco/db/queries/team-sync-state.js';
import { syncRow, backfillUnsynced, purgeNonMemberOutbox, countPending } from '@myco/db/queries/team-outbox.js';

function db(): Database {
  const d = new Database(':memory:');
  createSchema(d);
  return d;
}

function spore(id: string, projectId: string) {
  // In-memory row object for syncRow (NOT a DB insert) — no NOT-NULL cols needed.
  return { id, project_id: projectId, content: 'x', created_at: 1 };
}

// seedSpore(conn, id, projectId): real DB insert — see "Test fixtures & conventions".
function seedSpore(conn: Database, id: string, projectId: string) {
  conn.prepare(
    `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('user','user','built-in',1,1)`,
  ).run();
  conn.prepare(
    `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
     VALUES (?, ?, 'user', 'decision', 'x', 1, 'local')`,
  ).run(id, projectId);
}

describe('outbox membership gate', () => {
  it('syncRow enqueues a member project row and skips a non-member one', () => {
    withDatabase(db(), () => {
      setTeamSyncEnabled(true);
      setProjectSyncMembership(['member']);
      syncRow('spores', spore('s1', 'member'));
      syncRow('spores', spore('s2', 'outsider'));
      expect(countPending()).toBe(1);
    });
  });

  it('backfillUnsynced only enqueues rows whose project is a member', () => {
    withDatabase(db(), () => {
      setTeamSyncEnabled(true);
      setProjectSyncMembership(['member']);
      const conn = getDatabase();
      seedSpore(conn, 'm1', 'member'); // synced_at NULL
      seedSpore(conn, 'o1', 'outsider');
      const n = backfillUnsynced('machine-1');
      expect(n).toBe(1); // only the member row
      expect(countPending()).toBe(1);
    });
  });

  it('a delete of a non-member project row does NOT enqueue a delete op (trigger gate)', () => {
    withDatabase(db(), () => {
      setTeamSyncEnabled(true); // grove participates (mixed)
      setProjectSyncMembership(['member']);
      const conn = getDatabase();
      seedSpore(conn, 'm1', 'member');
      seedSpore(conn, 'o1', 'outsider');
      conn.prepare('DELETE FROM team_outbox').run(); // clear inserts
      conn.prepare(`DELETE FROM spores WHERE id = 'o1'`).run(); // non-member delete
      expect(countPending()).toBe(0); // trigger suppressed
      conn.prepare(`DELETE FROM spores WHERE id = 'm1'`).run(); // member delete
      expect(countPending()).toBe(1); // trigger fired
    });
  });

  it('purgeNonMemberOutbox removes sent + pending rows for non-member projects, keeps members and self-rows', () => {
    withDatabase(db(), () => {
      const conn = getDatabase();
      // team_outbox.id is INTEGER PRIMARY KEY AUTOINCREMENT — use integer ids.
      const ins = conn.prepare(
        `INSERT INTO team_outbox (id, table_name, row_id, operation, payload, machine_id, project_id, created_at, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      ins.run(1, 'spores', '1', 'upsert', '{}', 'm', 'member', 1, null); // member pending
      ins.run(2, 'spores', '2', 'upsert', '{}', 'm', 'outsider', 1, 5); // non-member SENT
      ins.run(3, 'spores', '3', 'upsert', '{}', 'm', 'outsider', 1, null); // non-member pending
      ins.run(4, 'team_members', 'm', 'upsert', '{}', 'm', null, 1, 5); // self-row (project_id NULL)
      const removed = purgeNonMemberOutbox(['member']);
      expect(removed).toBe(2);
      const left = (conn.prepare('SELECT id FROM team_outbox ORDER BY id').all() as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(left).toEqual([1, 4]); // member row + self-row survive
    });
  });

  it('does not re-enqueue non-member rows across repeated backfills (the flood)', () => {
    withDatabase(db(), () => {
      setTeamSyncEnabled(true);
      setProjectSyncMembership([]); // grove owns no member project
      const conn = getDatabase();
      for (let i = 0; i < 50; i++) seedSpore(conn, `x${i}`, 'outsider');
      // Reproduce the original flood loop: backfill, mark every pending row sent
      // (no route exists, so synced_at on the source row is never set), backfill
      // again. Without the membership filter each round would re-enqueue all 50
      // rows (the dedup only checks pending rows), leaving 5 × 50 = 250 rows. The
      // gate keeps the non-member rows out entirely, so nothing ever enqueues.
      for (let round = 0; round < 5; round++) {
        backfillUnsynced('m');
        conn.prepare('UPDATE team_outbox SET sent_at = 9 WHERE sent_at IS NULL').run();
      }
      expect((conn.prepare('SELECT COUNT(*) c FROM team_outbox').get() as { c: number }).c).toBe(0);
    });
  });
});
