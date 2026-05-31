/**
 * Migration v53 -> v54: re-key file-sweep plans from `path:<path>` onto the
 * shared session-scoped `session:<sid>:file:<path>` structure. The id and
 * source_path are preserved; only logical_key changes. Session-less rows fall
 * back to a sentinel segment. Already-session-scoped keys are left untouched.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';

const epochNow = () => Math.floor(Date.now() / 1000);

function seedSession(id: string): void {
  getDatabase()
    .prepare(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES (?, 'claude-code', ?, ?)`)
    .run(id, epochNow(), epochNow());
}

function rollbackToV53(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (53, ?)').run(epochNow());
}

describe('migrate v53 -> v54: plan identity unification', () => {
  beforeAll(() => setupTestDb());
  beforeEach(() => cleanTestDb());
  afterAll(() => teardownTestDb());

  it('re-keys a path: plan onto the session-scoped file key, preserving id and source_path', () => {
    const db = getDatabase();
    seedSession('sess-1');
    db.prepare(
      `INSERT INTO plans (id, logical_key, status, content, source_path, session_id, content_hash, processed, created_at)
       VALUES ('plan-x', 'path:docs/plans/x.md', 'active', '# X', 'docs/plans/x.md', 'sess-1', 'h', 0, ?)`,
    ).run(epochNow());

    rollbackToV53();
    createSchema(db);

    const row = db.prepare(`SELECT id, logical_key, source_path FROM plans WHERE id = 'plan-x'`)
      .get() as { id: string; logical_key: string; source_path: string };
    expect(row.id).toBe('plan-x');
    expect(row.logical_key).toBe('session:sess-1:file:docs/plans/x.md');
    expect(row.source_path).toBe('docs/plans/x.md');
  });

  it('keys a session-less path: plan under the legacy namespace (its own stable id)', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO plans (id, logical_key, status, content, source_path, session_id, content_hash, processed, created_at)
       VALUES ('plan-y', 'path:docs/plans/y.md', 'active', '# Y', 'docs/plans/y.md', NULL, 'h', 0, ?)`,
    ).run(epochNow());

    rollbackToV53();
    createSchema(db);

    const row = db.prepare(`SELECT logical_key FROM plans WHERE id = 'plan-y'`).get() as { logical_key: string };
    expect(row.logical_key).toBe('legacy:plan-y');
  });

  it('leaves already-session-scoped keys untouched', () => {
    const db = getDatabase();
    seedSession('sess-2');
    db.prepare(
      `INSERT INTO plans (id, logical_key, status, content, source_path, session_id, content_hash, processed, created_at)
       VALUES ('plan-z', 'session:sess-2:key:roadmap', 'active', '# Z', NULL, 'sess-2', 'h', 0, ?)`,
    ).run(epochNow());

    rollbackToV53();
    createSchema(db);

    const row = db.prepare(`SELECT logical_key FROM plans WHERE id = 'plan-z'`).get() as { logical_key: string };
    expect(row.logical_key).toBe('session:sess-2:key:roadmap');
  });
});
