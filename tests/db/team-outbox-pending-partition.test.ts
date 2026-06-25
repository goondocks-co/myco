/**
 * DB-backed tests for localPartition and pendingRowIdsForPartition.
 *
 * Covers:
 *   - pendingRowIdsForPartition returns only sent_at IS NULL row_ids for the
 *     exact (table, machine_id, project_id) partition.
 *   - pendingRowIdsForPartition excludes rows from other partitions and sent rows.
 *   - localPartition returns the partition's rows with id (and content_hash for
 *     content-hash tables, absent for presence-only tables).
 *   - SF4: localPartition for skill_usage does NOT reference synced_at
 *     (verified both by SQL inspection and by a live fixture that would throw
 *     if the column were queried on the columnless table).
 */

import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import {
  localPartition,
  pendingRowIdsForPartition,
} from '@myco/db/queries/team-outbox.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });
beforeEach(() => { cleanTestDb(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a minimal agent row needed by FK-constrained tables. */
function seedAgent(db: ReturnType<typeof getDatabase>, id = 'agent-1'): void {
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
     VALUES (?, 'test-agent', 'built-in', 1, 1)`,
  ).run(id);
}

/** Insert a minimal session row (needed by skill_usage FK). */
function seedSession(
  db: ReturnType<typeof getDatabase>,
  id: string,
  machineId: string,
  projectId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, agent, project_id, machine_id, created_at, started_at, status)
     VALUES (?, 'claude', ?, ?, 1, 1, 'closed')`,
  ).run(id, projectId, machineId);
}

/** Insert a minimal skill_record row (needed by skill_usage FK). */
function seedSkillRecord(
  db: ReturnType<typeof getDatabase>,
  id: string,
  machineId: string,
  projectId: string,
): void {
  seedAgent(db);
  db.prepare(
    `INSERT OR IGNORE INTO skill_records
       (id, project_id, agent_id, machine_id, name, display_name, description, path, created_at, updated_at)
     VALUES (?, ?, 'agent-1', ?, 'test-skill', 'Test Skill', 'desc', '/fake', 1, 1)`,
  ).run(id, projectId, machineId);
}

/** Insert a skill_usage row (has id+machine_id+project_id but no synced_at). */
function seedSkillUsage(
  db: ReturnType<typeof getDatabase>,
  opts: { id: string; machineId: string; projectId: string; skillId: string; sessionId: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO skill_usage (id, project_id, skill_id, session_id, machine_id, detected_at)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(opts.id, opts.projectId, opts.skillId, opts.sessionId, opts.machineId);
}

/** Insert a spore row (has content_hash + synced_at). */
function seedSpore(
  db: ReturnType<typeof getDatabase>,
  opts: { id: string; machineId: string; projectId: string; contentHash?: string },
): void {
  seedAgent(db);
  db.prepare(
    `INSERT OR IGNORE INTO spores
       (id, project_id, agent_id, observation_type, content, created_at, machine_id, content_hash)
     VALUES (?, ?, 'agent-1', 'decision', 'x', 1, ?, ?)`,
  ).run(opts.id, opts.projectId, opts.machineId, opts.contentHash ?? null);
}

/** Insert a raw team_outbox row. */
function seedOutboxRow(
  db: ReturnType<typeof getDatabase>,
  opts: {
    tableName: string;
    rowId: string;
    machineId: string;
    projectId: string;
    sentAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, project_id, created_at, sent_at)
     VALUES (?, ?, 'upsert', '{}', ?, ?, 1, ?)`,
  ).run(opts.tableName, opts.rowId, opts.machineId, opts.projectId, opts.sentAt ?? null);
}

// ---------------------------------------------------------------------------
// pendingRowIdsForPartition
// ---------------------------------------------------------------------------

describe('pendingRowIdsForPartition', () => {
  it('returns only sent_at IS NULL row_ids for the exact (table, machine_id, project_id)', () => {
    const db = getDatabase();

    // Pending rows for the target partition.
    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-1', machineId: 'mA', projectId: 'pA' });
    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-2', machineId: 'mA', projectId: 'pA' });
    // Sent row for the same partition — must be excluded.
    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-sent', machineId: 'mA', projectId: 'pA', sentAt: 99 });

    const result = pendingRowIdsForPartition('spores', 'mA', 'pA');

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    expect(result.has('row-1')).toBe(true);
    expect(result.has('row-2')).toBe(true);
    expect(result.has('row-sent')).toBe(false);
  });

  it('excludes rows from a different machine_id', () => {
    const db = getDatabase();

    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-A', machineId: 'mA', projectId: 'pA' });
    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-B', machineId: 'mB', projectId: 'pA' });

    const result = pendingRowIdsForPartition('spores', 'mA', 'pA');
    expect(result.has('row-A')).toBe(true);
    expect(result.has('row-B')).toBe(false);
  });

  it('excludes rows from a different project_id', () => {
    const db = getDatabase();

    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-pA', machineId: 'mA', projectId: 'pA' });
    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-pB', machineId: 'mA', projectId: 'pB' });

    const result = pendingRowIdsForPartition('spores', 'mA', 'pA');
    expect(result.has('row-pA')).toBe(true);
    expect(result.has('row-pB')).toBe(false);
  });

  it('excludes rows for a different table_name', () => {
    const db = getDatabase();

    seedOutboxRow(db, { tableName: 'spores', rowId: 'row-spore', machineId: 'mA', projectId: 'pA' });
    seedOutboxRow(db, { tableName: 'plans', rowId: 'row-plan', machineId: 'mA', projectId: 'pA' });

    const result = pendingRowIdsForPartition('spores', 'mA', 'pA');
    expect(result.has('row-spore')).toBe(true);
    expect(result.has('row-plan')).toBe(false);
  });

  it('returns an empty Set when the partition has no pending rows', () => {
    const result = pendingRowIdsForPartition('spores', 'mA', 'pA');
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// localPartition — content-hash table (spores)
// ---------------------------------------------------------------------------

describe('localPartition — spores (content_hash table)', () => {
  it('returns rows for the exact (machineId, projectId) partition', () => {
    const db = getDatabase();

    seedSpore(db, { id: 'sp-1', machineId: 'mA', projectId: 'pA', contentHash: 'hash-1' });
    seedSpore(db, { id: 'sp-2', machineId: 'mA', projectId: 'pA', contentHash: 'hash-2' });
    // Different partition — must not appear.
    seedSpore(db, { id: 'sp-other', machineId: 'mB', projectId: 'pA' });

    const rows = localPartition('mA', 'pA', 'spores');

    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['sp-1', 'sp-2']);
  });

  it('includes content_hash when present on the row', () => {
    const db = getDatabase();
    seedSpore(db, { id: 'sp-hash', machineId: 'mA', projectId: 'pA', contentHash: 'abc123' });

    const rows = localPartition('mA', 'pA', 'spores');
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe('abc123');
  });

  it('omits content_hash property when the row has no hash (NULL)', () => {
    const db = getDatabase();
    // Insert spore without a content_hash (NULL stored).
    seedSpore(db, { id: 'sp-no-hash', machineId: 'mA', projectId: 'pA' });

    const rows = localPartition('mA', 'pA', 'spores');
    expect(rows).toHaveLength(1);
    // content_hash should be absent (undefined) on the returned object.
    expect(rows[0].content_hash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// localPartition — presence-only table (skill_usage) — SF4
// ---------------------------------------------------------------------------

describe('localPartition — skill_usage (no synced_at, presence-only) — SF4', () => {
  it('returns rows without content_hash for skill_usage', () => {
    const db = getDatabase();
    seedSession(db, 'sess-1', 'mA', 'pA');
    seedSkillRecord(db, 'skill-1', 'mA', 'pA');
    seedSkillUsage(db, { id: 'su-1', machineId: 'mA', projectId: 'pA', skillId: 'skill-1', sessionId: 'sess-1' });

    const rows = localPartition('mA', 'pA', 'skill_usage');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('su-1');
    // skill_usage has no content_hash column → property must be absent.
    expect(rows[0].content_hash).toBeUndefined();
  });

  it('SF4: localPartition for skill_usage does not reference synced_at', () => {
    // skill_usage has no synced_at column. If localPartition generated SQL
    // that referenced synced_at, SQLite would throw "no such column".
    // Seeding a real row and calling localPartition is the live assertion.
    const db = getDatabase();
    seedSession(db, 'sess-sf4', 'mA', 'pA');
    seedSkillRecord(db, 'skill-sf4', 'mA', 'pA');
    seedSkillUsage(db, {
      id: 'su-sf4',
      machineId: 'mA',
      projectId: 'pA',
      skillId: 'skill-sf4',
      sessionId: 'sess-sf4',
    });

    // This call must not throw.
    expect(() => localPartition('mA', 'pA', 'skill_usage')).not.toThrow();
    const rows = localPartition('mA', 'pA', 'skill_usage');
    expect(rows).toHaveLength(1);
  });

  it('excludes skill_usage rows from other partitions', () => {
    const db = getDatabase();
    seedSession(db, 'sess-2', 'mA', 'pA');
    seedSession(db, 'sess-3', 'mB', 'pB');
    seedSkillRecord(db, 'skill-2', 'mA', 'pA');
    seedSkillRecord(db, 'skill-3', 'mB', 'pB');
    seedSkillUsage(db, { id: 'su-pA', machineId: 'mA', projectId: 'pA', skillId: 'skill-2', sessionId: 'sess-2' });
    seedSkillUsage(db, { id: 'su-pB', machineId: 'mB', projectId: 'pB', skillId: 'skill-3', sessionId: 'sess-3' });

    const rows = localPartition('mA', 'pA', 'skill_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('su-pA');
  });
});
