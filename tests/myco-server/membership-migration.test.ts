/**
 * Schema step 5 — the properties the flat-membership migration must have.
 *
 * It runs over live production rows, so each property here is a thing that
 * would be expensive or impossible to undo once applied.
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';

const upTo = (version: number) => SCHEMA_STEPS.filter((s) => s.version <= version).flatMap((s) => s.statements);
const applyV5 = (db: Database) => { for (const s of SCHEMA_STEPS.filter((x) => x.version === 5).flatMap((x) => x.statements)) db.exec(s); };

/** A v4 database carrying one operator-minted credential, as production does. */
function seededV4(over: { machineId?: string | null; extra?: Array<[string, string]> } = {}): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const s of upTo(4)) db.exec(s);
  db.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0)`).run();
  const issued = 1_700_000_000_000;
  const machineId = over.machineId === undefined ? 'machine_1' : over.machineId;
  db.query(`INSERT INTO member_tokens
      (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written,
       lineage_root, lineage_started_at, predecessor_id, first_used_at)
      VALUES ('tok_1','proj_1',?,'hash_1',?,NULL,4096,'tok_1',?,NULL,NULL)`)
    .run(machineId, issued + MEMBER_TOKEN_TTL_MS, issued);
  for (const [id, machine] of over.extra ?? []) {
    db.query(`INSERT INTO member_tokens
        (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written,
         lineage_root, lineage_started_at, predecessor_id, first_used_at)
        VALUES (?, 'proj_1', ?, 'hash_' || ?, ?, NULL, 0, ?, ?, NULL, NULL)`)
      .run(id, machine, id, issued + MEMBER_TOKEN_TTL_MS, id, issued);
  }
  return db;
}

const rows = <T,>(db: Database, sql: string): T[] => db.query(sql).all() as T[];

describe('flat-membership migration (schema step 5)', () => {
  it('lands every backfilled credential REVOKED, so no existing bearer silently gains Deployment-wide authority', () => {
    const db = seededV4();
    applyV5(db);
    const creds = rows<{ id: string; revoked_at: number | null }>(db, `SELECT id, revoked_at FROM member_credentials`);
    expect(creds.length).toBe(1);
    expect({ id: creds[0].id, live: creds[0].revoked_at === null }).toEqual({ id: 'tok_1', live: false });
  });

  it('preserves the charged byte counter, so migrating resets no quota', () => {
    const db = seededV4();
    applyV5(db);
    expect(rows<{ bytes_written: number }>(db, `SELECT bytes_written FROM member_credentials`)[0].bytes_written).toBe(4096);
  });

  it('preserves lineage, so refresh history and attribution still resolve', () => {
    const db = seededV4();
    applyV5(db);
    const c = rows<{ lineage_root: string; lineage_started_at: number }>(db, `SELECT lineage_root, lineage_started_at FROM member_credentials`)[0];
    expect(c.lineage_root).toBe('tok_1');
    expect(c.lineage_started_at).toBe(1_700_000_000_000);
  });

  it('never rewrites history: the old rows and their project scope are left intact', () => {
    const db = seededV4();
    applyV5(db);
    const old = rows<{ id: string; project_id: string }>(db, `SELECT id, project_id FROM member_tokens`);
    expect(old).toEqual([{ id: 'tok_1', project_id: 'proj_1' }]);
  });

  it('groups credentials of one machine under one member, and distinct machines under distinct members', () => {
    const db = seededV4({ extra: [['tok_2', 'machine_1'], ['tok_3', 'machine_2']] });
    applyV5(db);
    expect(rows<{ id: string }>(db, `SELECT id FROM members ORDER BY id`).map((m) => m.id))
      .toEqual(['mem_machine_1', 'mem_machine_2']);
    expect(rows<{ member_id: string }>(db, `SELECT member_id FROM member_credentials WHERE id IN ('tok_1','tok_2')`)
      .every((c) => c.member_id === 'mem_machine_1')).toBe(true);
  });

  it('ABORTS on a credential with no machine identity rather than fusing distinct humans into one member', () => {
    const db = seededV4({ machineId: null });
    expect(() => applyV5(db)).toThrow();
    // The guard fails before anything is created, so the step records nothing.
    expect(() => db.query(`SELECT 1 FROM member_credentials`).all()).toThrow();
  });

  it('is idempotent: applying it twice changes nothing', () => {
    const db = seededV4({ extra: [['tok_2', 'machine_2']] });
    applyV5(db);
    const first = JSON.stringify([
      rows(db, `SELECT * FROM members ORDER BY id`),
      rows(db, `SELECT * FROM member_credentials ORDER BY id`),
    ]);
    applyV5(db);
    expect(JSON.stringify([
      rows(db, `SELECT * FROM members ORDER BY id`),
      rows(db, `SELECT * FROM member_credentials ORDER BY id`),
    ])).toBe(first);
  });

  it('keeps the quota constraint named `member_tokens_quota`, which telemetry matches to make a violation terminal', () => {
    const ddl = SCHEMA_STEPS.filter((s) => s.version === 5).flatMap((s) => s.statements)
      .find((s) => s.includes('CREATE TABLE IF NOT EXISTS member_credentials'))!;
    expect(ddl).toContain('CONSTRAINT member_tokens_quota CHECK');
  });

  it('carries forward the one-live-successor index, which lineage-fork detection depends on', () => {
    const db = seededV4();
    applyV5(db);
    const idx = rows<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='member_credentials'`)
      .map((i) => i.name);
    expect(idx).toContain('idx_member_credentials_live_successor');
    expect(idx).toContain('idx_member_credentials_hash');
  });
});
