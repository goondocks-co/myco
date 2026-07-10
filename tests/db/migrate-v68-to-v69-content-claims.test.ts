/**
 * Tests for the v68 -> v69 migration: content claim system (Team Host WS2).
 *
 * Adds `content_claims` (the publication lock, with its ACTIVE-partial
 * unique index) and `content_publications` (the durable last-published
 * marker). Both are grove-resident and deliberately absent from every
 * team-sync list — see tests/db/synced-table-parity.test.ts, which stays
 * green precisely because neither table is registered in any of the five
 * lists it guards.
 *
 * Also backfills `content_publications` for every pre-existing active
 * artifact at its current generation — reaching the repo through the legacy
 * pre-claim-system path counts as already published, so the Unpublished
 * badge only lights for content that changes AFTER the migration runs.
 *
 * Builds a v68-shaped vault (drop the new tables, rewind schema_version to
 * 68), re-runs createSchema to apply migrateV68ToV69, and asserts the delta
 * in isolation. The migration-matrix suite covers fresh=migrated parity
 * structurally.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';

const now = 1_782_000_000;
const LOCAL = 'test-machine';
const PROJECT = 'proj_test1';

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function indexExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** Build a v68-shaped DB: full schema with the v69 delta removed. */
function seedV68Db(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.exec('DROP TABLE IF EXISTS content_claims');
  db.exec('DROP TABLE IF EXISTS content_publications');
  db.prepare(`DELETE FROM schema_version WHERE version > 68`).run();
  return db;
}

function seedAgent(db: Database, id = 'agent-1'): void {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, created_at) VALUES (?, 'Agent', ?)`).run(id, now);
}

function seedSession(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, created_at, machine_id) VALUES (?, 'claude-code', ?, ?, ?)`,
  ).run(id, now, now, LOCAL);
}

function seedSpore(db: Database, id: string, content: string): void {
  db.prepare(
    `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
     VALUES (?, ?, 'agent-1', 'gotcha', ?, ?, ?)`,
  ).run(id, PROJECT, content, now, LOCAL);
}

function seedSkillRecord(
  db: Database,
  id: string,
  opts: { generation?: number; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, status, generation, path, created_at, updated_at)
     VALUES (?, ?, 'agent-1', ?, ?, 'A test skill', ?, ?, ?, ?, ?)`,
  ).run(id, PROJECT, id, id, opts.status ?? 'active', opts.generation ?? 1, `.myco/skills/${id}.md`, now, now);
}

function seedOkfPageRow(
  db: Database,
  id: string,
  opts: { generation?: number; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO okf_pages (id, project_id, path, type, title, status, generation, created_at, updated_at)
     VALUES (?, ?, ?, 'concept', ?, ?, ?, ?, ?)`,
  ).run(id, PROJECT, `concepts/${id}`, id, opts.status ?? 'active', opts.generation ?? 1, now, now);
}

function getPublication(db: Database, artifactKind: string, artifactId: string): Record<string, unknown> | null {
  return db.prepare(
    `SELECT * FROM content_publications WHERE artifact_kind = ? AND artifact_id = ?`,
  ).get(artifactKind, artifactId) as Record<string, unknown> | null;
}

interface ClaimFields {
  id: string;
  artifactKind: string;
  artifactId: string;
  generation: number;
  state: string;
  releasedAt?: number | null;
  publishedAt?: number | null;
}

function insertClaim(db: Database, fields: ClaimFields): void {
  db.prepare(
    `INSERT INTO content_claims (
       id, artifact_kind, artifact_id, generation, project_id, claimed_by,
       claimed_at, expires_at, state, released_at, published_at, machine_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    fields.artifactKind,
    fields.artifactId,
    fields.generation,
    PROJECT,
    LOCAL,
    now,
    now + 86_400,
    fields.state,
    fields.releasedAt ?? null,
    fields.publishedAt ?? null,
    LOCAL,
  );
}

describe('migrateV68ToV69 — content claim system', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(69);
  });

  it('fresh install creates both tables with the spec-authoritative shape', () => {
    const db = new Database(':memory:');
    createSchema(db);

    expect(tableExists(db, 'content_claims')).toBe(true);
    expect(tableExists(db, 'content_publications')).toBe(true);
    expect(indexExists(db, 'idx_content_claims_active')).toBe(true);
    expect(indexExists(db, 'idx_content_claims_project_id')).toBe(true);

    expect(columnNames(db, 'content_claims')).toEqual([
      'id', 'artifact_kind', 'artifact_id', 'generation', 'project_id',
      'claimed_by', 'claimed_at', 'expires_at', 'state', 'released_at',
      'published_at', 'machine_id',
    ]);
    expect(columnNames(db, 'content_publications')).toEqual([
      'artifact_kind', 'artifact_id', 'published_generation', 'published_at',
      'published_by', 'machine_id',
    ]);

    const pkCols = (db.prepare(`PRAGMA table_info(content_publications)`).all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(['artifact_kind', 'artifact_id']);

    // content_claims is project-scoped (backup/move/project-delete registry);
    // content_publications has no project_id and is deliberately absent.
    expect(GROVE_PROJECT_SCOPED_TABLES).toContain('content_claims');
    expect(GROVE_PROJECT_SCOPED_TABLES).not.toContain('content_publications');

    db.close();
  });

  it('an existing v68 vault migrates: both tables and the active-unique index materialize, stamping v69', () => {
    const db = seedV68Db();
    expect(tableExists(db, 'content_claims')).toBe(false);
    expect(tableExists(db, 'content_publications')).toBe(false);

    createSchema(db);

    expect(tableExists(db, 'content_claims')).toBe(true);
    expect(tableExists(db, 'content_publications')).toBe(true);
    expect(indexExists(db, 'idx_content_claims_active')).toBe(true);
    expect(indexExists(db, 'idx_content_claims_project_id')).toBe(true);

    const stamped = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('migration is a no-op on unrelated rows of a real v68 vault', () => {
    const db = seedV68Db();
    seedAgent(db);
    seedSession(db, 'sess-1');
    seedSpore(db, 'spore-1', 'unrelated content, must survive the v69 migration untouched');

    createSchema(db);

    const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get('sess-1');
    expect(session).toBeTruthy();

    const spore = db.prepare(`SELECT content FROM spores WHERE id = ?`).get('spore-1') as { content: string } | undefined;
    expect(spore?.content).toBe('unrelated content, must survive the v69 migration untouched');

    const sessionCount = (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
    expect(sessionCount).toBe(1);
    const sporeCount = (db.prepare(`SELECT COUNT(*) AS n FROM spores`).get() as { n: number }).n;
    expect(sporeCount).toBe(1);

    db.close();
  });

  it('re-running createSchema on an already-migrated vault is idempotent', () => {
    const db = seedV68Db();
    createSchema(db);
    insertClaim(db, { id: 'cclaim_idem0000000000000000000000', artifactKind: 'skill', artifactId: 'skill-idem', generation: 1, state: 'active' });

    createSchema(db);

    const n = (db.prepare(`SELECT COUNT(*) AS n FROM content_claims`).get() as { n: number }).n;
    expect(n).toBe(1);

    db.close();
  });
});

describe('migrateV68ToV69 — content_publications backfill (pre-existing artifacts treated as published)', () => {
  it('seeds a publication row at exactly the current generation for a pre-existing active skill and OKF page', () => {
    const db = seedV68Db();
    seedAgent(db);
    seedSkillRecord(db, 'skill-1', { generation: 3 });
    seedOkfPageRow(db, 'page-1', { generation: 2 });

    createSchema(db);

    const skillPub = getPublication(db, 'skill', 'skill-1');
    expect(skillPub).toMatchObject({ published_generation: 3, published_by: 'local', machine_id: 'local' });
    const pagePub = getPublication(db, 'okf_page', 'page-1');
    expect(pagePub).toMatchObject({ published_generation: 2, published_by: 'local', machine_id: 'local' });

    db.close();
  });

  it('does not seed a row for a retired OKF page or a non-active skill', () => {
    const db = seedV68Db();
    seedAgent(db);
    seedSkillRecord(db, 'skill-inactive', { generation: 2, status: 'stale' });
    seedOkfPageRow(db, 'page-retired', { generation: 4, status: 'retired' });

    createSchema(db);

    expect(getPublication(db, 'skill', 'skill-inactive')).toBeNull();
    expect(getPublication(db, 'okf_page', 'page-retired')).toBeNull();

    db.close();
  });

  it('an artifact created AFTER the migration has no publication row — the Unpublished badge lights for it', () => {
    const db = seedV68Db();
    createSchema(db); // migrates to v69; nothing pre-existing to seed

    seedAgent(db);
    seedSkillRecord(db, 'skill-new', { generation: 1 });

    expect(getPublication(db, 'skill', 'skill-new')).toBeNull();

    db.close();
  });

  it('is idempotent: a real mark-published recorded after the first migration pass survives a second pass untouched', () => {
    const db = seedV68Db();
    seedAgent(db);
    seedSkillRecord(db, 'skill-1', { generation: 3 });
    createSchema(db); // first pass seeds published_generation = 3

    // Simulate a REAL publish since then (the artifact evolved to gen 5 and
    // was re-published through the normal claim flow).
    db.prepare(
      `UPDATE content_publications SET published_generation = 5, published_by = 'machine-real'
         WHERE artifact_kind = 'skill' AND artifact_id = 'skill-1'`,
    ).run();

    // Rewind ONLY the version row (the tables/data survive) to re-trigger the
    // v69 migration's seed step, as if createSchema ran again mid-upgrade.
    db.prepare(`DELETE FROM schema_version WHERE version > 68`).run();
    createSchema(db);

    const pub = getPublication(db, 'skill', 'skill-1');
    expect(pub).toMatchObject({ published_generation: 5, published_by: 'machine-real' });

    db.close();
  });
});

describe('content_claims ACTIVE-partial unique index', () => {
  it('blocks a second ACTIVE claim on the same (artifact_kind, artifact_id)', () => {
    const db = new Database(':memory:');
    createSchema(db);

    insertClaim(db, { id: 'cclaim_aaaa000000000000000000000000', artifactKind: 'skill', artifactId: 'skill-1', generation: 1, state: 'active' });

    expect(() => {
      insertClaim(db, { id: 'cclaim_bbbb000000000000000000000000', artifactKind: 'skill', artifactId: 'skill-1', generation: 1, state: 'active' });
    }).toThrow();

    const activeCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM content_claims WHERE artifact_kind = 'skill' AND artifact_id = 'skill-1' AND state = 'active'`).get() as { n: number }
    ).n;
    expect(activeCount).toBe(1);

    db.close();
  });

  it('allows a new ACTIVE claim on the same artifact once the prior claim is released', () => {
    const db = new Database(':memory:');
    createSchema(db);

    insertClaim(db, { id: 'cclaim_cccc000000000000000000000000', artifactKind: 'skill', artifactId: 'skill-2', generation: 1, state: 'active' });

    db.prepare(`UPDATE content_claims SET state = 'released', released_at = ? WHERE id = ?`)
      .run(now, 'cclaim_cccc000000000000000000000000');

    expect(() => {
      insertClaim(db, { id: 'cclaim_dddd000000000000000000000000', artifactKind: 'skill', artifactId: 'skill-2', generation: 2, state: 'active' });
    }).not.toThrow();

    const activeCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM content_claims WHERE artifact_kind = 'skill' AND artifact_id = 'skill-2' AND state = 'active'`).get() as { n: number }
    ).n;
    expect(activeCount).toBe(1);

    const totalCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM content_claims WHERE artifact_kind = 'skill' AND artifact_id = 'skill-2'`).get() as { n: number }
    ).n;
    expect(totalCount).toBe(2);

    db.close();
  });

  it('allows two distinct artifacts to each hold an ACTIVE claim concurrently', () => {
    const db = new Database(':memory:');
    createSchema(db);

    insertClaim(db, { id: 'cclaim_eeee000000000000000000000000', artifactKind: 'skill', artifactId: 'skill-3', generation: 1, state: 'active' });
    insertClaim(db, { id: 'cclaim_ffff000000000000000000000000', artifactKind: 'okf_page', artifactId: 'page-1', generation: 1, state: 'active' });

    const activeCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM content_claims WHERE state = 'active'`).get() as { n: number }
    ).n;
    expect(activeCount).toBe(2);

    db.close();
  });
});
