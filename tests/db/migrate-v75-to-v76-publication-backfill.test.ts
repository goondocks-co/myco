/**
 * migrateV75ToV76 — content_publications backfill to current generation.
 *
 * Claim-gated materialization ships in v76: agent skill writes stop landing
 * on disk, so "claimable" (lineage generation ahead of publication) must mean
 * "a new version you have not published" — not "a skill the old direct-write
 * model already delivered". The migration UPSERTS a publication row at the
 * current generation for every ACTIVE skill record. The upsert (not
 * INSERT OR IGNORE) is the load-bearing detail: v69 already seeded rows at
 * then-current generations, and those must be BUMPED or the migration fixes
 * nothing for exactly the skills that motivated it.
 */

import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const NOW = 1754000000;

function seedV75Vault(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'local');
  // Roll the stamped version back to simulate a vault frozen at v75. A fresh
  // install stamps only the current SCHEMA_VERSION, so stamp 75 explicitly —
  // an empty schema_version table would re-run the whole chain (and v69's
  // publication seed would mask what v76 does).
  db.prepare('DELETE FROM schema_version WHERE version > 75').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (75, ?) ON CONFLICT (version) DO NOTHING').run(NOW);

  db.prepare('INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)').run('agent-1', 'agent one', NOW);

  const insertSkill = db.prepare(
    `INSERT INTO skill_records (id, agent_id, machine_id, name, display_name, description, status, generation, path, created_at, updated_at)
     VALUES (?, 'agent-1', ?, ?, ?, 'test skill', ?, ?, ?, ?, ?)`,
  );
  // Active skill at gen 6 with a v69-era publication row stuck at gen 3.
  insertSkill.run('sk-1', 'machine-a', 'alpha', 'Alpha', 'active', 6, '.agents/skills/alpha/SKILL.md', NOW, NOW);
  db.prepare(
    `INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id)
     VALUES ('skill', 'sk-1', 3, ?, 'user', 'machine-a')`,
  ).run(NOW - 1000);
  // Retired skill: must NOT gain a publication row.
  insertSkill.run('sk-2', 'local', 'beta', 'Beta', 'retired', 2, '.agents/skills/beta/SKILL.md', NOW, NOW);
  // Active skill with no publication row at all (pre-v69-shape or never published).
  insertSkill.run('sk-4', 'machine-b', 'delta', 'Delta', 'active', 1, '.agents/skills/delta/SKILL.md', NOW, NOW);
  // Publication row with no surviving skill record (orphan): untouched.
  db.prepare(
    `INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id)
     VALUES ('skill', 'sk-3', 4, ?, 'user', 'machine-a')`,
  ).run(NOW - 2000);

  return db;
}

function getPublication(db: Database, artifactId: string): {
  published_generation: number; published_by: string; machine_id: string;
} | null {
  return (db.prepare(
    'SELECT published_generation, published_by, machine_id FROM content_publications WHERE artifact_kind = ? AND artifact_id = ?',
  ).get('skill', artifactId) as { published_generation: number; published_by: string; machine_id: string } | undefined) ?? null;
}

describe('migrateV75ToV76 — content_publications backfill to current generation', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(76);
  });

  it('bumps a v69-seeded publication row to the current generation (the upsert case)', () => {
    const db = seedV75Vault();
    createSchema(db);
    const pub = getPublication(db, 'sk-1');
    expect(pub?.published_generation).toBe(6);
    expect(pub?.published_by).toBe('migration:v76-backfill');
  });

  it('inserts a publication row for an active skill that never had one', () => {
    const db = seedV75Vault();
    createSchema(db);
    const pub = getPublication(db, 'sk-4');
    expect(pub?.published_generation).toBe(1);
    expect(pub?.machine_id).toBe('machine-b');
  });

  it('does not backfill retired skills and leaves orphan publication rows untouched', () => {
    const db = seedV75Vault();
    createSchema(db);
    expect(getPublication(db, 'sk-2')).toBeNull();
    expect(getPublication(db, 'sk-3')?.published_generation).toBe(4);
    expect(getPublication(db, 'sk-3')?.published_by).toBe('user');
  });

  it('advances the vault to v76', () => {
    const db = seedV75Vault();
    createSchema(db);
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(76);
  });

  it('is idempotent — a second createSchema() call does not error or rewrite rows', () => {
    const db = seedV75Vault();
    createSchema(db);
    const first = getPublication(db, 'sk-1');
    createSchema(db);
    expect(getPublication(db, 'sk-1')).toEqual(first);
  });

  it('a fresh install has the table and no publication rows', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM content_publications').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
