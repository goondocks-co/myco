/**
 * v75 — residency ingest-trust prerequisites: `entity_mentions` gains an `id`
 * primary key (rebuild) with a project_id backfill from the owning entity, and
 * the ten timestamp-ordered residency tables gain a nullable `received_at`.
 *
 * The rebuild is the risky half: real vaults hold mention rows keyed only by
 * the four-column UNIQUE, and every one must survive with a fresh unique id
 * and its derivable tenancy stored. The DEFAULT-expression id also has to
 * cover a pre-v75 binary's id-less INSERT (the NULL-TEXT-PK class that
 * corrupted prompt_batches across the v73 rollback).
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const RECEIVED_AT_TABLES = [
  'spores', 'plans', 'artifacts', 'skill_candidates', 'skill_records',
  'okf_generations', 'okf_pages', 'knowledge_release_state', 'entities', 'digest_extracts',
];

function columns(db: Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
  );
}

function seedV74LegacyVault(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db, 'local');
  // A fresh install stamps ONLY the latest version, so roll back by replacing
  // the stamp — deleting `> 74` alone would empty the table and replay the
  // whole chain from v1 over a current-shape vault.
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (74, 1)').run();
  // Recreate the PRE-v75 entity_mentions shape (no id column) with real rows.
  db.exec('DROP TABLE entity_mentions');
  db.exec(`CREATE TABLE entity_mentions (
    project_id  TEXT,
    entity_id   TEXT NOT NULL REFERENCES entities(id),
    note_id     TEXT NOT NULL,
    note_type   TEXT NOT NULL,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER,
    UNIQUE (entity_id, note_id, note_type, agent_id)
  )`);
  // Strip received_at back off the ten tables so the ALTER half runs too.
  for (const table of RECEIVED_AT_TABLES) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN received_at`);
  }
  db.prepare(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('a1', 'a1', 'built-in', 1, 1)`).run();
  db.prepare(
    `INSERT INTO entities (id, project_id, agent_id, type, name, first_seen, last_seen, status)
     VALUES ('e1', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1', 't', 'n', 1, 1, 'active')`,
  ).run();
  db.prepare(
    `INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id)
     VALUES ('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'e1', 'sp1', 'spore', 'a1', 'm1')`,
  ).run();
  // A legacy NULL-project mention — tenancy derivable from the entity but unstored.
  db.prepare(
    `INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id)
     VALUES (NULL, 'e1', 'sp2', 'spore', 'a1', 'm1')`,
  ).run();
  return db;
}

describe('migrateV74ToV75 — residency ingest-trust prerequisites', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(75);
  });

  it('a fresh install already has the new shape', () => {
    const db = new Database(':memory:');
    createSchema(db);
    expect(columns(db, 'entity_mentions').has('id')).toBe(true);
    for (const table of RECEIVED_AT_TABLES) {
      expect(columns(db, table).has('received_at')).toBe(true);
    }
  });

  it('a v74 vault migrates: every mention survives with a unique id, NULL project_id backfilled from its entity', () => {
    const db = seedV74LegacyVault();
    createSchema(db);

    const version = (db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }).version;
    expect(version).toBeGreaterThanOrEqual(75);

    const rows = db.prepare('SELECT id, project_id, note_id FROM entity_mentions ORDER BY note_id').all() as Array<{ id: string; project_id: string; note_id: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.id).toMatch(/^ment_[0-9a-f]{32}$/);
      expect(row.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);

    for (const table of RECEIVED_AT_TABLES) {
      expect(columns(db, table).has('received_at')).toBe(true);
    }
  });

  it('the four-column dedup survives the rebuild', () => {
    const db = seedV74LegacyVault();
    createSchema(db);
    db.prepare(
      `INSERT OR IGNORE INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id)
       VALUES ('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'e1', 'sp1', 'spore', 'a1', 'm2')`,
    ).run();
    const c = (db.prepare(`SELECT COUNT(*) AS c FROM entity_mentions WHERE note_id = 'sp1'`).get() as { c: number }).c;
    expect(c).toBe(1);
  });

  it("a pre-v75 binary's id-less INSERT still produces a keyed row (DEFAULT expression, never a NULL TEXT PK)", () => {
    const db = seedV74LegacyVault();
    createSchema(db);
    db.prepare(
      `INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id)
       VALUES ('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'e1', 'sp3', 'spore', 'a1', 'm1')`,
    ).run();
    const row = db.prepare(`SELECT id FROM entity_mentions WHERE note_id = 'sp3'`).get() as { id: string | null };
    expect(row.id).toMatch(/^ment_[0-9a-f]{32}$/);
  });

  it('an ORPHANED mention (entity row gone) survives the rebuild instead of bricking the vault', () => {
    // Restores run FK-off with INSERT OR IGNORE, so a real vault can hold a
    // mention whose entity vanished. The rebuild copies history — it must not
    // re-validate years-old rows against live FKs and refuse to open.
    const db = seedV74LegacyVault();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id)
                VALUES (NULL, 'e_gone', 'sp_orphan', 'spore', 'a1', 'm1')`).run();
    db.exec('PRAGMA foreign_keys = ON');

    createSchema(db); // must not throw

    const rows = db.prepare('SELECT id, project_id FROM entity_mentions ORDER BY note_id').all() as Array<{ id: string; project_id: string | null }>;
    expect(rows).toHaveLength(3);
    const orphan = db.prepare(`SELECT id, project_id FROM entity_mentions WHERE note_id = 'sp_orphan'`).get() as { id: string; project_id: string | null };
    expect(orphan.id).toMatch(/^ment_[0-9a-f]{32}$/);
    expect(orphan.project_id).toBeNull(); // unowned stays unowned — recorded, not invented
  });

  it('fresh install and migrated vault agree on column ORDER for every table this migration touches', () => {
    // ALTER appends at the end of the column list, so the fresh DDL must
    // declare received_at as the LAST column — a mid-table declaration makes
    // fresh and upgraded vaults diverge in PRAGMA table_info order (the v42
    // shape-equality class).
    const fresh = new Database(':memory:');
    createSchema(fresh);
    const migrated = seedV74LegacyVault();
    createSchema(migrated);
    for (const table of [...RECEIVED_AT_TABLES, 'entity_mentions']) {
      const order = (db: Database) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(order(migrated), table).toEqual(order(fresh));
    }
  });

  it('is idempotent — a second createSchema() call neither errors nor duplicates', () => {
    const db = seedV74LegacyVault();
    createSchema(db);
    const before = db.prepare('SELECT id FROM entity_mentions ORDER BY note_id').all();
    createSchema(db);
    expect(db.prepare('SELECT id FROM entity_mentions ORDER BY note_id').all()).toEqual(before);
  });
});
