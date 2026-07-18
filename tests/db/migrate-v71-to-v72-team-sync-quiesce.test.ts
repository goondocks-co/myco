/**
 * Tests for the v71 -> v72 migration: quiesce the preserved team-outbox
 * machinery on vaults that carry legacy team-sync membership rows.
 *
 * Team Host E-2 deletes the legacy team-sync transport (drain, flush loop,
 * the `enabled`-flag write in `deleteProjectPermanently`), but preserves
 * `team_outbox`, `syncRow`, and the per-table `AFTER DELETE` triggers for a
 * future phase. Their gate is `team_sync_membership` — a persistent DB row
 * set, not the volatile `enabled` flag. Any vault that ever connected to a
 * legacy team still has those rows, so without this migration the preserved
 * machinery keeps enqueuing outbox rows forever with nothing left to drain
 * them.
 *
 * This migration clears the gate (`team_sync_membership`), resets the
 * legacy `enabled` flag for coherence, and purges pending (never-sent)
 * outbox rows — mirroring `purgePendingOutbox`'s SQL exactly. Already-sent
 * rows are left untouched: they are a bounded historical set (the same gate
 * clear stops new ones), and their cleanup belongs to `pruneOld`'s own
 * prune-only-acked retention posture, not to a one-time upgrade step.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { withDatabase } from '@myco/db/client.js';
import { getSyncableProjectTeamId, getTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

function membershipCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM team_sync_membership').get() as { n: number }).n;
}

function enabledFlag(db: Database): number {
  const row = db.prepare('SELECT enabled FROM team_sync_state WHERE rowid_guard = 1').get() as
    | { enabled: number }
    | undefined;
  return row?.enabled ?? 0;
}

function pendingOutboxCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM team_outbox WHERE sent_at IS NULL').get() as { n: number }).n;
}

function sentOutboxCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM team_outbox WHERE sent_at IS NOT NULL').get() as { n: number }).n;
}

function stampedVersion(db: Database): number {
  return (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
}

/**
 * Build a v71-shaped vault carrying legacy team-sync state: a membership
 * row, `enabled = 1`, and both a pending and a sent outbox row. Stamped at
 * exactly 71 so `createSchema` runs `migrateV71ToV72` on the next call.
 */
function seedV71LegacyVault(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'local');
  db.prepare('DELETE FROM schema_version WHERE version > 71').run();

  db.prepare(
    `INSERT INTO team_sync_state (rowid_guard, enabled) VALUES (1, 1)
     ON CONFLICT (rowid_guard) DO UPDATE SET enabled = 1`,
  ).run();
  db.prepare(
    `INSERT INTO team_sync_membership (project_id, team_id) VALUES ('proj_legacy', 'team_legacy')`,
  ).run();
  db.prepare(
    `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at, sent_at)
     VALUES ('spores', 'sp_pending', 'upsert', '{"id":"sp_pending"}', 'legacy-machine', 'team_legacy', 'proj_legacy', 1000, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at, sent_at)
     VALUES ('spores', 'sp_sent', 'upsert', '{"id":"sp_sent"}', 'legacy-machine', 'team_legacy', 'proj_legacy', 1000, 2000)`,
  ).run();

  return db;
}

describe('migrateV71ToV72 — quiesce the preserved team-outbox machinery', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
  });

  it('a fresh install starts already quiesced', () => {
    const db = new Database(':memory:');
    createSchema(db);

    expect(membershipCount(db)).toBe(0);
    expect(enabledFlag(db)).toBe(0);
    expect(pendingOutboxCount(db)).toBe(0);

    db.close();
  });

  it('a v71 vault with legacy membership + pending/sent outbox rows is cleared, stamping v72', () => {
    const db = seedV71LegacyVault();
    expect(membershipCount(db)).toBe(1);
    expect(enabledFlag(db)).toBe(1);
    expect(pendingOutboxCount(db)).toBe(1);
    expect(sentOutboxCount(db)).toBe(1);

    createSchema(db);

    expect(membershipCount(db)).toBe(0);
    expect(enabledFlag(db)).toBe(0);
    expect(pendingOutboxCount(db)).toBe(0);
    // Already-sent rows are untouched — cleanup is pruneOld's job, not this migration's.
    expect(sentOutboxCount(db)).toBe(1);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('tables, indexes, and delete triggers all survive — this is a data clear, not a schema removal', () => {
    const db = seedV71LegacyVault();
    createSchema(db);

    const objectExists = (type: string, name: string) =>
      !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name);

    expect(objectExists('table', 'team_outbox')).toBe(true);
    expect(objectExists('table', 'team_sync_state')).toBe(true);
    expect(objectExists('table', 'team_sync_membership')).toBe(true);
    expect(objectExists('trigger', 'spores_team_ad')).toBe(true);

    db.close();
  });

  it('is idempotent — re-running createSchema on an already-migrated vault does not error or resurrect rows', () => {
    const db = seedV71LegacyVault();
    createSchema(db);
    createSchema(db); // second boot

    expect(membershipCount(db)).toBe(0);
    expect(enabledFlag(db)).toBe(0);
    expect(pendingOutboxCount(db)).toBe(0);
    expect(sentOutboxCount(db)).toBe(1);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('running the migration on an already-quiescent v71 vault is a safe no-op', () => {
    const db = new Database(':memory:');
    createSchema(db, 'local');
    db.prepare('DELETE FROM schema_version WHERE version > 71').run();
    // No membership, no outbox rows seeded -- vault is already quiescent at v71.

    expect(() => createSchema(db)).not.toThrow();
    expect(membershipCount(db)).toBe(0);
    expect(enabledFlag(db)).toBe(0);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });
});

describe('post-migration quiescence: the preserved machinery goes silent', () => {
  it('syncRow enqueues nothing once membership is cleared (the gate returns null)', () => {
    const db = seedV71LegacyVault();
    createSchema(db); // migrate to v72 -- clears team_sync_membership

    withDatabase(db, () => {
      expect(getSyncableProjectTeamId('proj_legacy')).toBeNull();
      syncRow('spores', { id: 'sp_new', project_id: 'proj_legacy', created_at: 5000 });
      expect(pendingOutboxCount(db)).toBe(0);
    });

    db.close();
  });

  it('a row delete on a trigger-covered table journals nothing once membership is cleared', () => {
    const db = seedV71LegacyVault();
    createSchema(db); // migrate to v72

    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
       VALUES ('sp_after', 'proj_legacy', 'user', 'decision', 'active', 'c', 1, 'legacy-machine')`,
    ).run();
    db.prepare(`DELETE FROM spores WHERE id = 'sp_after'`).run();

    const deletes = db.prepare(`SELECT COUNT(*) AS n FROM team_outbox WHERE operation = 'delete'`).get() as {
      n: number;
    };
    expect(deletes.n).toBe(0);

    db.close();
  });

  it('getTeamSyncEnabled reads false after migration', () => {
    const db = seedV71LegacyVault();
    createSchema(db);

    expect(getTeamSyncEnabled(db)).toBe(false);

    db.close();
  });
});
