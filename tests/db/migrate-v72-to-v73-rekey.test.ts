/**
 * Tests for the v72 -> v73 migration: rekey prompt_batches,
 * knowledge_release_state, and digest_extracts from INTEGER AUTOINCREMENT ids
 * to portable Grove-era text ids (`<prefix>_<32 hex>`).
 *
 * This is the first table rebuild in the migration chain. It runs with foreign
 * keys OFF (toggled outside the transaction, since the pragma is a no-op
 * inside one), rewrites every inbound FK and soft reference to prompt_batches,
 * rebuilds the external-content FTS index onto the table rowid, converts the
 * intelligence agent's persisted cursor, and leaves digest_extract_revisions
 * (which keeps its integer id) untouched.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { isGroveEraId } from '@myco/grove/ids.js';
import { epochSeconds } from '@myco/constants.js';

/**
 * Build the current schema, then revert the three rekeyed tables to their v72
 * (integer-id) shape and stamp the vault at v72, so the next createSchema runs
 * migrateV72ToV73 over integer-keyed rows.
 */
function seedV72Vault(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'local');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DROP TABLE IF EXISTS prompt_batches_fts');
  db.exec('DROP TABLE prompt_batches');
  db.exec('DROP TABLE knowledge_release_state');
  db.exec('DROP TABLE digest_extracts');

  db.exec(`CREATE TABLE prompt_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    parent_prompt_batch_id INTEGER REFERENCES prompt_batches(id),
    kind TEXT NOT NULL DEFAULT 'initial',
    origin TEXT NOT NULL DEFAULT 'human',
    prompt_number INTEGER,
    user_prompt TEXT, response_summary TEXT, classification TEXT,
    started_at INTEGER, ended_at INTEGER, status TEXT DEFAULT 'active',
    activity_count INTEGER DEFAULT 0, processed INTEGER DEFAULT 0,
    content_hash TEXT, created_at INTEGER NOT NULL,
    machine_id TEXT NOT NULL DEFAULT 'local', synced_at INTEGER,
    thread_id TEXT, thread_label TEXT
  )`);
  db.exec(`CREATE TABLE knowledge_release_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT,
    machine_id TEXT NOT NULL DEFAULT 'local', identity_key TEXT NOT NULL UNIQUE,
    namespace TEXT NOT NULL, record_id TEXT NOT NULL,
    source_session_id TEXT REFERENCES sessions(id),
    source_prompt_batch_id INTEGER REFERENCES prompt_batches(id),
    state TEXT NOT NULL, confidence TEXT NOT NULL, basis_kind TEXT, basis_ref TEXT,
    basis_sha TEXT, release_pr_number INTEGER, reason TEXT, evidence_json TEXT,
    checked_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER, synced_at INTEGER
  )`);
  db.exec(`CREATE TABLE digest_extracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT,
    agent_id TEXT NOT NULL REFERENCES agents(id), tier INTEGER NOT NULL,
    content TEXT NOT NULL, substrate_hash TEXT, generated_at INTEGER NOT NULL,
    machine_id TEXT NOT NULL DEFAULT 'local', synced_at INTEGER
  )`);
  db.exec(`CREATE VIRTUAL TABLE prompt_batches_fts USING fts5(user_prompt, response_summary, content='prompt_batches', content_rowid='id')`);
  db.exec(`CREATE TRIGGER prompt_batches_fts_ai AFTER INSERT ON prompt_batches BEGIN
    INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary); END`);
  db.exec('PRAGMA foreign_keys = ON');
  // createSchema stamps only the final version, so rolling the marker back
  // means clearing the table and stamping exactly 72 — otherwise the marker is
  // empty and createSchema replays the whole chain from zero.
  db.exec('DELETE FROM schema_version');
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (72, ?)').run(epochSeconds());

  db.exec(`INSERT INTO agents (id, name, created_at) VALUES ('agent1', 'Test', 1000)`);
  db.exec(`INSERT INTO sessions (id, agent, started_at, created_at, project_id) VALUES ('sess1', 'claude-code', 1000, 1000, 'proj_a')`);
  db.exec(`INSERT INTO prompt_batches (id, project_id, session_id, parent_prompt_batch_id, origin, prompt_number, user_prompt, response_summary, created_at) VALUES
    (1, 'proj_a', 'sess1', NULL, 'human', 1, 'migrate the schema carefully today', 'ok', 1000),
    (2, 'proj_a', 'sess1', 1, 'system', NULL, 'system envelope wrapper', 'sys', 1001),
    (3, 'proj_a', 'sess1', NULL, 'human', 2, 'unrelated conversation topic', NULL, 1002)`);
  db.exec(`INSERT INTO prompt_batches_fts(prompt_batches_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO activities (id, project_id, session_id, prompt_batch_id, tool_name, timestamp, created_at) VALUES
    (10, 'proj_a', 'sess1', 1, 'Read', 1000, 1000),
    (11, 'proj_a', 'sess1', 2, 'Edit', 1001, 1001)`);
  db.exec(`INSERT INTO plans (id, project_id, logical_key, session_id, prompt_batch_id, created_at) VALUES ('plan_1', 'proj_a', 'lk', 'sess1', 3, 1002)`);
  db.exec(`INSERT INTO spores (id, project_id, agent_id, session_id, prompt_batch_id, observation_type, content, created_at) VALUES ('spore_1', 'proj_a', 'agent1', 'sess1', 1, 'decision', 'a decision', 1000)`);
  db.exec(`INSERT INTO attachments (id, project_id, session_id, prompt_batch_id, file_path, created_at) VALUES ('att_1', 'proj_a', 'sess1', 1, '/tmp/x.png', 1000)`);
  db.exec(`INSERT INTO knowledge_git_provenance (project_id, machine_id, identity_key, session_id, prompt_batch_id, capture_point, captured_at, status_hash, created_at) VALUES ('proj_a', 'local', 'ik1', 'sess1', 1, 'pre', 1000, 'sh', 1000)`);
  db.exec(`INSERT INTO knowledge_release_state (project_id, machine_id, identity_key, namespace, record_id, source_session_id, source_prompt_batch_id, state, confidence, checked_at, created_at) VALUES ('proj_a', 'local', 'ik2', 'ns', 'rec1', 'sess1', 3, 'released', 'high', 1000, 1000)`);
  db.exec(`INSERT INTO graph_edges (id, project_id, agent_id, source_id, source_type, target_id, target_type, type, created_at) VALUES
    ('edge_1', 'proj_a', 'agent1', 'spore_1', 'spore', '1', 'batch', 'EXTRACTED_FROM', 1000),
    ('edge_2', 'proj_a', 'agent1', 'sess1', 'session', '2', 'batch', 'HAS_BATCH', 1001)`);
  db.exec(`INSERT INTO agent_state (agent_id, project_id, key, value, updated_at) VALUES ('agent1', 'proj_a', 'last_processed_batch_id', '2', 1001)`);
  db.exec(`INSERT INTO digest_extracts (id, project_id, agent_id, tier, content, generated_at) VALUES (100, 'proj_a', 'agent1', 1500, 'digest content', 1000)`);
  db.exec(`INSERT INTO digest_extract_revisions (id, project_id, agent_id, tier, content, created_at) VALUES (200, 'proj_a', 'agent1', 1500, 'rev content', 1000)`);
  db.exec(`INSERT INTO routed_event_dedup (event_id, machine_id, kind, prompt_batch_id, created_at) VALUES ('m1:u1', 'local', 'user_prompt', 1, 1000)`);

  return db;
}

/** Map prompt_number -> new text id after migration (batch 2 has no number). */
function batchIdByNumber(db: Database): Map<number | null, string> {
  const rows = db.prepare('SELECT id, prompt_number FROM prompt_batches').all() as Array<{ id: string; prompt_number: number | null }>;
  return new Map(rows.map((r) => [r.prompt_number, r.id]));
}

describe('migrateV72ToV73 — rekey to grove-era text ids', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(73);
  });

  it('a fresh install stores text ids in the three rekeyed tables', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.exec(`INSERT INTO agents (id, name, created_at) VALUES ('a', 'A', 1)`);
    db.exec(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('s', 'cc', 1, 1)`);
    db.exec(`INSERT INTO prompt_batches (id, session_id, origin, created_at) VALUES ('pbat_${'a'.repeat(32)}', 's', 'human', 1)`);
    const t = db.prepare(`SELECT typeof(id) tp FROM prompt_batches`).get() as { tp: string };
    expect(t.tp).toBe('text');
    db.close();
  });

  it('rebuilds all three tables, rewrites every reference, and passes foreign_key_check', () => {
    const db = seedV72Vault();
    createSchema(db);

    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(SCHEMA_VERSION);

    const batches = db.prepare('SELECT id, parent_prompt_batch_id, prompt_number FROM prompt_batches').all() as Array<{ id: string; parent_prompt_batch_id: string | null; prompt_number: number | null }>;
    expect(batches.every((b) => isGroveEraId(b.id, 'prompt_batch'))).toBe(true);

    const byNum = batchIdByNumber(db);
    const batch1 = byNum.get(1)!;
    const batch3 = byNum.get(2)!;
    // batch 2 (system) has NULL prompt_number and parent = batch 1.
    const batch2 = batches.find((b) => b.parent_prompt_batch_id !== null)!;
    expect(batch2.parent_prompt_batch_id).toBe(batch1);

    // Every inbound FK column now holds the mapped text id.
    const act = db.prepare('SELECT prompt_batch_id, typeof(prompt_batch_id) tp FROM activities ORDER BY id').all() as Array<{ prompt_batch_id: string; tp: string }>;
    expect(act.every((a) => isGroveEraId(a.prompt_batch_id, 'prompt_batch') && a.tp === 'text')).toBe(true);
    expect(act[0].prompt_batch_id).toBe(batch1);
    expect(act[1].prompt_batch_id).toBe(batch2.id);

    expect((db.prepare(`SELECT prompt_batch_id FROM plans WHERE id='plan_1'`).get() as { prompt_batch_id: string }).prompt_batch_id).toBe(batch3);
    expect((db.prepare(`SELECT prompt_batch_id FROM spores WHERE id='spore_1'`).get() as { prompt_batch_id: string }).prompt_batch_id).toBe(batch1);
    expect((db.prepare(`SELECT prompt_batch_id FROM attachments WHERE id='att_1'`).get() as { prompt_batch_id: string }).prompt_batch_id).toBe(batch1);
    expect((db.prepare(`SELECT prompt_batch_id FROM knowledge_git_provenance WHERE identity_key='ik1'`).get() as { prompt_batch_id: string }).prompt_batch_id).toBe(batch1);

    const krs = db.prepare(`SELECT id, source_prompt_batch_id FROM knowledge_release_state WHERE identity_key='ik2'`).get() as { id: string; source_prompt_batch_id: string };
    expect(isGroveEraId(krs.id, 'knowledge_release_state')).toBe(true);
    expect(krs.source_prompt_batch_id).toBe(batch3);

    // Lineage edges: numeric-string batch targets rewritten to the new text ids.
    const edges = db.prepare(`SELECT id, target_id FROM graph_edges WHERE target_type='batch'`).all() as Array<{ id: string; target_id: string }>;
    expect(edges.every((e) => isGroveEraId(e.target_id, 'prompt_batch'))).toBe(true);
    expect(edges.find((e) => e.id === 'edge_1')!.target_id).toBe(batch1);
    expect(edges.find((e) => e.id === 'edge_2')!.target_id).toBe(batch2.id);

    // Host-local dedup ledger soft reference rewritten.
    const red = db.prepare(`SELECT prompt_batch_id, typeof(prompt_batch_id) tp FROM routed_event_dedup`).get() as { prompt_batch_id: string; tp: string };
    expect(isGroveEraId(red.prompt_batch_id, 'prompt_batch')).toBe(true);
    expect(red.prompt_batch_id).toBe(batch1);

    expect(db.prepare('PRAGMA foreign_key_check').all().length).toBe(0);
    db.close();
  });

  it('converts the persisted agent cursor to the new batch id', () => {
    const db = seedV72Vault();
    createSchema(db);
    const batch2 = db.prepare('SELECT id FROM prompt_batches WHERE parent_prompt_batch_id IS NOT NULL').get() as { id: string };
    const cursor = db.prepare(`SELECT value FROM agent_state WHERE key='last_processed_batch_id'`).get() as { value: string };
    expect(cursor.value).toBe(batch2.id);
    expect(isGroveEraId(cursor.value, 'prompt_batch')).toBe(true);
    db.close();
  });

  it('rekeys digest_extracts but leaves digest_extract_revisions integer id untouched', () => {
    const db = seedV72Vault();
    createSchema(db);
    const dig = db.prepare('SELECT id FROM digest_extracts').get() as { id: string };
    expect(isGroveEraId(dig.id, 'digest_extract')).toBe(true);
    const rev = db.prepare('SELECT id, typeof(id) tp FROM digest_extract_revisions').get() as { id: number; tp: string };
    expect(rev.id).toBe(200);
    expect(rev.tp).toBe('integer');
    db.close();
  });

  it('rebuilds the FTS index so pre-migration batch content is still searchable', () => {
    const db = seedV72Vault();
    createSchema(db);
    const batch1 = (batchIdByNumber(db)).get(1)!;
    const hits = db.prepare(
      `SELECT pb.id FROM prompt_batches_fts fts JOIN prompt_batches pb ON pb.rowid = fts.rowid WHERE prompt_batches_fts MATCH 'schema'`,
    ).all() as Array<{ id: string }>;
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(batch1);

    // The rebuilt insert trigger keeps new rows searchable by table rowid.
    db.exec(`INSERT INTO prompt_batches (id, project_id, session_id, origin, user_prompt, created_at) VALUES ('pbat_${'b'.repeat(32)}', 'proj_a', 'sess1', 'human', 'freshly inserted needle', 1003)`);
    const hits2 = db.prepare(
      `SELECT pb.id FROM prompt_batches_fts fts JOIN prompt_batches pb ON pb.rowid = fts.rowid WHERE prompt_batches_fts MATCH 'needle'`,
    ).all();
    expect(hits2.length).toBe(1);
    db.close();
  });

  it('a fresh install and a migrated vault converge to identical column structure', () => {
    const fresh = new Database(':memory:');
    createSchema(fresh);
    const migrated = seedV72Vault();
    createSchema(migrated);

    // Compare column structure via PRAGMA rather than the raw CREATE text:
    // ALTER TABLE ... RENAME cosmetically double-quotes the table name in
    // sqlite_master.sql, which is semantically identical but not byte-equal.
    const structure = (db: Database, table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>)
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`);
    const fks = (db: Database, table: string) =>
      (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>)
        .map((f) => `${f.from}->${f.table}.${f.to}`).sort();

    for (const table of ['prompt_batches', 'knowledge_release_state', 'digest_extracts']) {
      expect(structure(migrated, table), `${table} columns`).toEqual(structure(fresh, table));
      expect(fks(migrated, table), `${table} foreign keys`).toEqual(fks(fresh, table));
    }

    // The FTS index must bind to the table rowid in both.
    const ftsFor = (db: Database) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name='prompt_batches_fts'`).get() as { sql: string }).sql;
    expect(ftsFor(migrated)).toContain("content_rowid='rowid'");
    expect(ftsFor(migrated)).toBe(ftsFor(fresh));

    fresh.close();
    migrated.close();
  });

  it('re-running the migration on an already-migrated vault is a no-op (ids unchanged)', () => {
    const db = seedV72Vault();
    createSchema(db);
    const before = db.prepare('SELECT id FROM prompt_batches ORDER BY prompt_number').all() as Array<{ id: string }>;

    // Directly re-invoke the migration the way the full-chain replay test does.
    const idBefore = before.map((r) => r.id).join(',');
    createSchema(db); // reapply path — must not re-rekey
    const after = db.prepare('SELECT id FROM prompt_batches ORDER BY prompt_number').all() as Array<{ id: string }>;
    expect(after.map((r) => r.id).join(',')).toBe(idBefore);
    db.close();
  });
});
