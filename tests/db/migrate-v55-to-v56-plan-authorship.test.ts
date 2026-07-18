import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const now = 1_780_600_000;
const LOCAL = 'test-machine';
const PROJECT = 'proj_test1';

function seedSession(db: Database, id: string, machineId = LOCAL): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, created_at, machine_id, project_id)
     VALUES (?, 'claude-code', ?, ?, ?, ?)`,
  ).run(id, now, now, machineId, PROJECT);
}

function seedBatch(db: Database, sessionId: string): number {
  const info = db.prepare(
    `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
     VALUES (?, 1, ?, ?, 'active')`,
  ).run(sessionId, now, now);
  return Number(info.lastInsertRowid);
}

function seedActivity(
  db: Database,
  sessionId: string,
  batchId: number,
  toolName: string,
  filePath: string,
): void {
  db.prepare(
    `INSERT INTO activities (session_id, prompt_batch_id, tool_name, file_path, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, batchId, toolName, filePath, now, now);
}

function seedPlan(
  db: Database,
  opts: {
    id: string;
    sessionId: string;
    sourcePath: string;
    machineId?: string;
    logicalKey?: string;
    content?: string;
  },
): void {
  const logicalKey = opts.logicalKey ?? `session:${opts.sessionId}:file:${opts.sourcePath}`;
  db.prepare(
    `INSERT INTO plans (id, project_id, logical_key, status, source_path, session_id, machine_id, created_at, content)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    PROJECT,
    logicalKey,
    opts.sourcePath,
    opts.sessionId,
    opts.machineId ?? LOCAL,
    now,
    opts.content ?? '# Plan\n\nbody',
  );
}

function planExists(db: Database, id: string): boolean {
  return (db.prepare(`SELECT COUNT(*) AS n FROM plans WHERE id = ?`).get(id) as { n: number }).n === 1;
}

function seedV55Db(): Database {
  const db = new Database(':memory:');
  createSchema(db, LOCAL);
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (55, ?)').run(now);

  // --- Group: shared.md — one genuine author + one mtime phantom -------------
  seedSession(db, 'author');
  seedActivity(db, 'author', seedBatch(db, 'author'), 'Write', 'docs/plans/shared.md');
  seedPlan(db, { id: 'p-author-shared', sessionId: 'author', sourcePath: 'docs/plans/shared.md' });

  seedSession(db, 'phantom');
  // phantom only READ the file — reading is not authorship.
  seedActivity(db, 'phantom', seedBatch(db, 'phantom'), 'Read', 'docs/plans/shared.md');
  seedPlan(db, { id: 'p-phantom-shared', sessionId: 'phantom', sourcePath: 'docs/plans/shared.md' });

  // --- Group: multi.md — two genuine authors (both kept) ---------------------
  seedSession(db, 'authorC');
  seedActivity(db, 'authorC', seedBatch(db, 'authorC'), 'Edit', 'docs/plans/multi.md');
  seedPlan(db, { id: 'p-c-multi', sessionId: 'authorC', sourcePath: 'docs/plans/multi.md' });

  seedSession(db, 'authorD');
  seedActivity(db, 'authorD', seedBatch(db, 'authorD'), 'write', 'docs/plans/multi.md');
  seedPlan(db, { id: 'p-d-multi', sessionId: 'authorD', sourcePath: 'docs/plans/multi.md' });

  // --- Group: orphan.md — no authorship anywhere (last copy preserved) -------
  seedSession(db, 'orphan');
  seedPlan(db, { id: 'p-orphan', sessionId: 'orphan', sourcePath: 'docs/plans/orphan.md' });

  // --- Group: canon.md — author recorded a `./`-prefixed path ----------------
  // Proves canonicalization: the activity path form differs from source_path,
  // yet authorship must still be recognized (symbiont-agnostic matching).
  seedSession(db, 'canonAuthor');
  seedActivity(db, 'canonAuthor', seedBatch(db, 'canonAuthor'), 'Write', './docs/plans/canon.md');
  seedPlan(db, { id: 'p-canon-author', sessionId: 'canonAuthor', sourcePath: 'docs/plans/canon.md' });

  seedSession(db, 'canonPhantom');
  seedPlan(db, { id: 'p-canon-phantom', sessionId: 'canonPhantom', sourcePath: 'docs/plans/canon.md' });

  // --- Non-local row — activities for its session live on another machine -----
  seedSession(db, 'remote', 'other-machine');
  seedPlan(db, {
    id: 'p-remote',
    sessionId: 'remote',
    sourcePath: 'docs/plans/remote.md',
    machineId: 'other-machine',
  });

  // --- Transcript tag plan — genuine per-session artifact, never a candidate -
  seedPlan(db, {
    id: 'p-tag',
    sessionId: 'author',
    sourcePath: 'transcript:proposed_plan',
    logicalKey: 'session:author:tag:proposed_plan',
  });

  return db;
}

describe('migration v55 -> v56: authorship-gated plan cleanup', () => {
  it('removes only mtime-phantom plan rows and preserves genuine, last-copy, non-local, and tag rows', () => {
    const db = seedV55Db();

    createSchema(db, LOCAL);

    // Phantom rows shadowed by a genuine author are removed.
    expect(planExists(db, 'p-phantom-shared')).toBe(false);
    expect(planExists(db, 'p-canon-phantom')).toBe(false);

    // Genuine authors are preserved (including both of a multi-author file).
    expect(planExists(db, 'p-author-shared')).toBe(true);
    expect(planExists(db, 'p-c-multi')).toBe(true);
    expect(planExists(db, 'p-d-multi')).toBe(true);

    // Canonicalization: the `./`-prefixed write still counts as authorship.
    expect(planExists(db, 'p-canon-author')).toBe(true);

    // Never delete the last copy when no row in the group is authored.
    expect(planExists(db, 'p-orphan')).toBe(true);

    // Non-local rows are untouched (their activities are not local).
    expect(planExists(db, 'p-remote')).toBe(true);

    // Transcript tag plans are not candidates.
    expect(planExists(db, 'p-tag')).toBe(true);

    const version = db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    };
    expect(version.version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('a mid-chain phantom-plan tombstone does not survive a vault that reaches head in one upgrade', () => {
    const db = seedV55Db();
    // plans carries an AFTER DELETE team-sync trigger gated on team_sync_state
    // and the project's membership in team_sync_membership.
    db.prepare(
      `INSERT INTO team_sync_state (rowid_guard, enabled) VALUES (1, 1)
         ON CONFLICT (rowid_guard) DO UPDATE SET enabled = 1`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO team_sync_membership (project_id, team_id) VALUES (?, ?)`,
    ).run(PROJECT, 'team-a');

    createSchema(db, LOCAL);

    // v56's phantom-plan cleanup deletes p-phantom-shared and p-canon-phantom,
    // and each delete fires the membership-gated trigger, so v56 DOES enqueue
    // 2 pending tombstones mid-chain (that mechanism is unchanged and still
    // fires — see tests/db/team-delete-triggers.test.ts for direct, isolated
    // coverage of trigger-enqueue-on-delete). But this test's `createSchema`
    // call chains all the way to SCHEMA_VERSION, not just to v56, and the
    // terminal quiesce migration (v71 -> v72, Team Host E-2 Task 5) purges
    // every pending (sent_at IS NULL) team_outbox row as its last step — so a
    // vault that goes from v55 straight to head in one upgrade never carries
    // those 2 tombstones forward: nothing will ever drain them anyway, since
    // the legacy team-sync transport that used to flush the outbox is gone.
    const tombstones = db.prepare(
      `SELECT COUNT(*) AS n FROM team_outbox WHERE table_name = 'plans' AND operation = 'delete'`,
    ).get() as { n: number };
    expect(tombstones.n).toBe(0);
    db.close();
  });
});
