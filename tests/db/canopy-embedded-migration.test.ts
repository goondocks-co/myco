import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { EMBEDDABLE_TABLES, EMBEDDABLE_TEXT_COLUMNS, getUnembedded, getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';

describe('canopy_entries.embedded migration v26', () => {
  it('adds embedded column with default 0 on fresh install', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = db.prepare(`PRAGMA table_info(canopy_entries)`).all() as Array<{
      name: string; dflt_value: string | null; notnull: number;
    }>;
    const embedded = cols.find((c) => c.name === 'embedded');
    expect(embedded).toBeDefined();
    expect(embedded?.dflt_value).toBe('0');
    expect(embedded?.notnull).toBe(0);
  });

  it('upgrades v25 → v26 idempotently', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(`UPDATE schema_version SET version = 25 WHERE version = ?`).run(SCHEMA_VERSION);
    db.prepare(`ALTER TABLE canopy_entries DROP COLUMN embedded`).run();

    createSchema(db);
    createSchema(db); // second call is a no-op

    const cols = db.prepare(`PRAGMA table_info(canopy_entries)`).all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'embedded')).toHaveLength(1);
  });

  it('SCHEMA_VERSION is 36', () => {
    expect(SCHEMA_VERSION).toBe(36);
  });

  it('migrateV25ToV26 is a no-op when column already exists', () => {
    const db = new Database(':memory:');
    createSchema(db); // installs at v26 with embedded column
    // Roll the version row back without dropping the column to simulate
    // a vault that was manually patched but not version-stamped.
    db.prepare(`UPDATE schema_version SET version = 25`).run();
    const migration = MIGRATIONS.find((m) => m.version === 26)!;
    expect(() => migration.migrate(db, 'local')).not.toThrow();
    const row = db.prepare(
      `SELECT MAX(version) AS v FROM schema_version`,
    ).get() as { v: number };
    expect(row.v).toBe(26);
  });
});

describe('canopy_entries in embeddable allowlist', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('includes canopy_entries in EMBEDDABLE_TABLES', () => {
    expect(EMBEDDABLE_TABLES).toContain('canopy_entries');
  });

  it('maps canopy_entries text column to llm_description', () => {
    expect(EMBEDDABLE_TEXT_COLUMNS.canopy_entries).toBe('llm_description');
  });

  it('getUnembedded(canopy_entries) only returns rows with non-null llm_description', () => {
    const db = getDatabase();
    const mechanicalAt = 1_700_000_000;
    const llmAt = 1_700_000_500;
    db.prepare(
      `INSERT INTO canopy_entries (project_id, machine_id, path, content_hash, size_bytes,
        token_estimate, line_count, mechanical_updated_at, llm_description, llm_updated_at, embedded)
       VALUES ('proj', 'local', 'a.ts', 'h1', 100, 20, 5, ?, 'described file a', ?, 0),
              ('proj', 'local', 'b.ts', 'h2', 100, 20, 5, ?, NULL, NULL, 0)`,
    ).run(mechanicalAt, llmAt, mechanicalAt);

    const rows = getUnembedded('canopy_entries', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('proj:a.ts');
    expect(rows[0].text).toBe('described file a');
    // Lock the contract: created_at on the returned shape is the mechanical
    // timestamp, not llm_updated_at. A future "fix" that swaps in the LLM
    // timestamp will fail here.
    expect(rows[0].created_at).toBe(mechanicalAt);
  });

  it('getEmbeddingQueueDepth includes canopy_entries pending count', () => {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO canopy_entries (project_id, machine_id, path, content_hash, size_bytes,
        token_estimate, line_count, mechanical_updated_at, llm_description, embedded)
       VALUES ('p', 'local', 'a.ts', 'h', 1, 1, 1, ?, 'desc', 0)`,
    ).run(now);
    expect(getEmbeddingQueueDepth().queue_depth).toBeGreaterThanOrEqual(1);
  });
});
