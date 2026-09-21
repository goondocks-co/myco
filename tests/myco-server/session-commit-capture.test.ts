/**
 * The commit a session stands on lands in git provenance, one row per capture
 * point, converging in any delivery order; anything but a full SHA writes nothing.
 */
import { describe, expect, it } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { seededSqlite, seedCredential, sqliteD1 } from './helpers/d1.js';
import { envelope, uuid } from './helpers/fixtures.js';

const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now: 5_000 };
const S1 = 'a'.repeat(40);
const S2 = 'b'.repeat(40);
const S3 = 'c'.repeat(40);

function rig() {
  const sqlite = seededSqlite();
  seedCredential(sqlite, { id: 'mt_1', machineId: 'machine_1', hash: 'h1' });
  return { db: sqliteD1(sqlite), sqlite };
}

const start = (n: number, createdAt: number, headSha?: string) =>
  envelope({ eventId: uuid(n), kind: 'session.start', createdAt, payload: { agent: 'claude-code', branch: 'feat/x', startedAt: createdAt, ...(headSha ? { headSha } : {}) } });
const end = (n: number, createdAt: number, headSha?: string) =>
  envelope({ eventId: uuid(n), kind: 'session.end', createdAt, payload: { endedAt: createdAt, ...(headSha ? { headSha } : {}) } });

const rows = (sqlite: ReturnType<typeof seededSqlite>) => sqlite.query(
  'SELECT identity_key, session_id, capture_point, head_sha, branch, captured_at FROM knowledge_git_provenance ORDER BY capture_point',
).all();

describe('session commit capture', () => {
  it('records the start and end commits with the session branch', async () => {
    const { db, sqlite } = rig();
    expect(await ingestEvent(db, ctx, start(1, 1_000, S1))).toEqual({ persisted: true, projected: true });
    expect(await ingestEvent(db, ctx, end(2, 2_000, S2))).toEqual({ persisted: true, projected: true });
    expect(rows(sqlite)).toEqual([
      { identity_key: 'session:sess_1:session_end', session_id: 'sess_1', capture_point: 'session_end', head_sha: S2, branch: 'feat/x', captured_at: 2_000 },
      { identity_key: 'session:sess_1:session_start', session_id: 'sess_1', capture_point: 'session_start', head_sha: S1, branch: 'feat/x', captured_at: 1_000 },
    ]);
  });

  it('keeps the latest end and the earliest start whatever order they arrive in', async () => {
    const { db, sqlite } = rig();
    await ingestEvent(db, ctx, start(1, 1_000, S1));
    await ingestEvent(db, ctx, end(3, 3_000, S3));
    await ingestEvent(db, ctx, end(2, 2_000, S2));
    await ingestEvent(db, ctx, start(4, 1_500, S2));
    expect((rows(sqlite) as Array<{ head_sha: string }>).map((r) => r.head_sha)).toEqual([S3, S1]);
  });

  it('writes nothing without a full commit SHA, and refuses an oversized one', async () => {
    const { db, sqlite } = rig();
    await ingestEvent(db, ctx, start(1, 1_000));
    await ingestEvent(db, ctx, end(2, 2_000, 'abc123'));
    expect(rows(sqlite)).toEqual([]);
    expect(await ingestEvent(db, ctx, end(3, 3_000, 'a'.repeat(41)))).toMatchObject({ persisted: false });
  });

  it('records whether tracked files differed from the end commit', async () => {
    const { db, sqlite } = rig();
    await ingestEvent(db, ctx, start(1, 1_000, S1));
    await ingestEvent(db, ctx, envelope({ eventId: uuid(2), kind: 'session.end', createdAt: 2_000, payload: { endedAt: 2_000, headSha: S2, dirty: true } }));
    expect(sqlite.query("SELECT capture_point, is_dirty FROM knowledge_git_provenance ORDER BY capture_point").all())
      .toEqual([{ capture_point: 'session_end', is_dirty: 1 }, { capture_point: 'session_start', is_dirty: 0 }]);
  });
});

