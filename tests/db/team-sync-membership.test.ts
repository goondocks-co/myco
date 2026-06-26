import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { withDatabase } from '@myco/db/client.js';
import {
  setProjectSyncMembership,
  getSyncableProjectIds,
  getSyncableProjectTeamId,
  isProjectSyncable,
} from '@myco/db/queries/team-sync-state.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  return db;
}

describe('team_sync_membership schema', () => {
  it('SCHEMA_VERSION is at least 62', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(62);
  });

  it('fresh install creates team_sync_membership with a project_id PK and carried team_id', () => {
    const db = freshDb();
    const cols = db.prepare(`PRAGMA table_info(team_sync_membership)`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('project_id');
    expect(names).toContain('team_id');
    expect(cols.find((c) => c.name === 'project_id')?.pk).toBe(1);
  });

  it('fresh install gates delete triggers on membership', () => {
    const db = freshDb();
    const trigger = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'spores_team_ad'`)
      .get() as { sql: string } | undefined;
    expect(trigger).toBeDefined();
    expect(trigger?.sql).toContain('OLD.project_id IN (SELECT project_id FROM team_sync_membership)');
  });

  it('upgrade from a pre-61 DB adds the table without data loss', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.exec('DROP TABLE team_sync_membership');
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (60, 0)').run();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('user','user','built-in',1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id) VALUES ('s1','p1','user','decision','x',1,'local')`,
    ).run();
    createSchema(db);
    expect(db.prepare(`SELECT COUNT(*) c FROM team_sync_membership`).get()).toEqual({ c: 0 });
    expect((db.prepare(`SELECT COUNT(*) c FROM spores`).get() as { c: number }).c).toBe(1);
  });

  it('upgrade recreates delete triggers with the membership-aware WHEN clause', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.exec('DROP TABLE team_sync_membership');
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (60, 0)').run();
    db.exec('DROP TRIGGER IF EXISTS spores_team_ad');
    db.exec(`
      CREATE TRIGGER spores_team_ad
      AFTER DELETE ON spores
      WHEN (SELECT enabled FROM team_sync_state) = 1
      BEGIN
        INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, project_id, created_at)
        VALUES ('spores', CAST(OLD.id AS TEXT), 'delete',
                json_object('id', OLD.id, 'machine_id', OLD.machine_id),
                OLD.machine_id, OLD.project_id, CAST(strftime('%s','now') AS INTEGER));
      END`);
    createSchema(db);
    const trigger = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'spores_team_ad'`)
      .get() as { sql: string } | undefined;
    expect(trigger?.sql).toContain('OLD.project_id IN (SELECT project_id FROM team_sync_membership)');
  });
});

describe('team_sync_membership accessors', () => {
  it('replaces the membership set and answers membership queries', () => {
    const db = freshDb();
    withDatabase(db, () => {
      setProjectSyncMembership([
        { project_id: 'p1', team_id: 'team-a' },
        { project_id: 'p2', team_id: 'team-a' },
      ]);
      expect(new Set(getSyncableProjectIds())).toEqual(new Set(['p1', 'p2']));
      expect(getSyncableProjectTeamId('p1')).toBe('team-a');
      expect(isProjectSyncable('p1')).toBe(true);
      expect(isProjectSyncable('p3')).toBe(false);
      expect(isProjectSyncable(null)).toBe(false);

      setProjectSyncMembership([{ project_id: 'p2', team_id: 'team-a' }]);
      expect(getSyncableProjectIds()).toEqual(['p2']);
      expect(isProjectSyncable('p1')).toBe(false);

      setProjectSyncMembership([]);
      expect(getSyncableProjectIds()).toEqual([]);
    });
  });

  it('stamps legacy pending outbox rows with the reconciled project team', () => {
    const db = freshDb();
    withDatabase(db, () => {
      db.prepare(
        `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at, sent_at)
         VALUES ('spores', 'legacy-delete', 'delete', '{}', 'machine-1', NULL, 'p1', 1, NULL)`,
      ).run();

      setProjectSyncMembership([{ project_id: 'p1', team_id: 'team-a' }]);

      const row = db.prepare(
        `SELECT team_id FROM team_outbox WHERE row_id = 'legacy-delete'`,
      ).get() as { team_id: string | null };
      expect(row.team_id).toBe('team-a');
    });
  });
});
