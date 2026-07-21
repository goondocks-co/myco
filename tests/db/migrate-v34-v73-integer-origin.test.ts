/**
 * Regression guard for the v34 DDL pin (migrations.ts V34_PROMPT_BATCHES_DDL /
 * V34_DIGEST_EXTRACTS_DDL).
 *
 * v34 rebuilds prompt_batches and digest_extracts. It must produce their
 * v34-era INTEGER key regardless of later schema evolution. If it referenced
 * the live (post-v73-rekey, now TEXT) constants instead, a vault that upgrades
 * from <= v33 would have v34 rebuild those tables to TEXT — storing the old
 * integer ids as numeric strings ("1", "2") — and the v73 rekey's
 * `v73IdIsInteger` guard would then SKIP them, silently leaving numeric-string
 * ids that are not Grove-era and never remapping the FK children.
 *
 * migration-matrix.test.ts does NOT catch this: its historical fixtures are
 * row-less schema dumps compared structurally, and both the pinned and unpinned
 * worlds converge to the same table shape and pass foreign_key_check (integer 1
 * matches text '1' via affinity). This test carries DATA and FK children
 * through the whole chain, so it fails the moment the pin is removed.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { isGroveEraId } from '@myco/grove/ids.js';
import { epochSeconds } from '@myco/constants.js';

/**
 * Build a <=v33-origin vault: prompt_batches and digest_extracts carry their
 * v34-era INTEGER key, populated with real rows plus FK children (activities,
 * spores), and stamped at v33 so the next createSchema replays v34 -> v73.
 */
function seedV33IntegerOriginVault(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'local');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DROP TABLE IF EXISTS prompt_batches_fts');
  db.exec('DROP TABLE prompt_batches');
  db.exec('DROP TABLE digest_extracts');
  db.exec(`CREATE TABLE prompt_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    parent_prompt_batch_id INTEGER REFERENCES prompt_batches(id),
    kind TEXT NOT NULL DEFAULT 'initial', prompt_number INTEGER,
    user_prompt TEXT, response_summary TEXT, classification TEXT,
    started_at INTEGER, ended_at INTEGER, status TEXT DEFAULT 'active',
    activity_count INTEGER DEFAULT 0, processed INTEGER DEFAULT 0, content_hash TEXT,
    created_at INTEGER NOT NULL, machine_id TEXT NOT NULL DEFAULT 'local', synced_at INTEGER
  )`);
  db.exec(`CREATE TABLE digest_extracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT,
    agent_id TEXT NOT NULL REFERENCES agents(id), tier INTEGER NOT NULL,
    content TEXT NOT NULL, substrate_hash TEXT, generated_at INTEGER NOT NULL,
    machine_id TEXT NOT NULL DEFAULT 'local', synced_at INTEGER
  )`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('DELETE FROM schema_version');
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (33, ?)').run(epochSeconds());

  db.exec(`INSERT INTO agents (id, name, created_at) VALUES ('agent1', 'A', 1000)`);
  db.exec(`INSERT INTO sessions (id, agent, started_at, created_at, project_id) VALUES ('sess1', 'claude-code', 1000, 1000, 'proj_a')`);
  db.exec(`INSERT INTO prompt_batches (id, project_id, session_id, parent_prompt_batch_id, prompt_number, user_prompt, created_at) VALUES
    (1, 'proj_a', 'sess1', NULL, 1, 'parent batch', 1000),
    (2, 'proj_a', 'sess1', 1, 2, 'child batch', 1001)`);
  db.exec(`INSERT INTO activities (id, project_id, session_id, prompt_batch_id, tool_name, timestamp, created_at) VALUES
    (1, 'proj_a', 'sess1', 1, 'Read', 1000, 1000),
    (2, 'proj_a', 'sess1', 2, 'Edit', 1001, 1001)`);
  db.exec(`INSERT INTO spores (id, project_id, agent_id, session_id, prompt_batch_id, observation_type, content, created_at) VALUES
    ('spore1', 'proj_a', 'agent1', 'sess1', 1, 'decision', 'a decision', 1000)`);
  db.exec(`INSERT INTO digest_extracts (id, project_id, agent_id, tier, content, generated_at) VALUES (1, 'proj_a', 'agent1', 1500, 'digest', 1000)`);

  return db;
}

describe('v34 pin regression — a <=v33-origin vault rekeys to grove-era ids through v34+v73', () => {
  it('leaves every batch/digest id as a grove-era text id with FK children intact (fails iff the v34 DDL pin is removed)', () => {
    const db = seedV33IntegerOriginVault();

    createSchema(db); // replay v34 -> v73

    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(SCHEMA_VERSION);

    const batches = db.prepare('SELECT id, prompt_number FROM prompt_batches ORDER BY prompt_number').all() as Array<{ id: string; prompt_number: number }>;
    expect(batches).toHaveLength(2);
    // Without the pin these would be the numeric strings "1"/"2" (v34 rebuilt to
    // TEXT, v73 skipped), which are NOT grove-era ids.
    expect(batches.every((b) => isGroveEraId(b.id, 'prompt_batch'))).toBe(true);
    const batch1 = batches.find((b) => b.prompt_number === 1)!.id;
    const batch2 = batches.find((b) => b.prompt_number === 2)!.id;

    // Self-ref and FK children carry the SAME remapped grove-era ids.
    const childBatch = db.prepare('SELECT parent_prompt_batch_id FROM prompt_batches WHERE prompt_number = 2').get() as { parent_prompt_batch_id: string };
    expect(childBatch.parent_prompt_batch_id).toBe(batch1);
    const acts = db.prepare('SELECT prompt_batch_id FROM activities ORDER BY id').all() as Array<{ prompt_batch_id: string }>;
    expect(acts.map((a) => a.prompt_batch_id)).toEqual([batch1, batch2]);
    const spore = db.prepare(`SELECT prompt_batch_id FROM spores WHERE id = 'spore1'`).get() as { prompt_batch_id: string };
    expect(spore.prompt_batch_id).toBe(batch1);

    const dig = db.prepare('SELECT id FROM digest_extracts').get() as { id: string };
    expect(isGroveEraId(dig.id, 'digest_extract')).toBe(true);

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    db.close();
  });
});
