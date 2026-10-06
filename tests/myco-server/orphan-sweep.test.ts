import { expect, it } from 'bun:test';
import { registerBlob } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { freeOrphanedBlobs, TRANSCRIPT_RETENTION_BLOBS_PER_PASS } from '@myco-server-worker/ingest/retention.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';

const key = (n: number): string => n.toString(16).padStart(64, '0');
const NOW = BLOB_RESERVATION_TTL_MS + 2;
const cursor = (sqlite: ReturnType<typeof sqliteEnv>['sqlite']) =>
  sqlite.query(`SELECT cursor_project, cursor_key, revision FROM orphan_sweep_state WHERE id = 1`).get() as { cursor_project: string; cursor_key: string; revision: number };

it('bounds examined identities with all-held pages and reaches a sparse orphan at the tail', async () => {
  const { sqlite, serverEnv } = sqliteEnv();
  const plan = sqlite.query(`EXPLAIN QUERY PLAN SELECT project_id,key,received_at FROM blobs
    WHERE (project_id,key)>(?,?) ORDER BY project_id,key LIMIT ?`).all('', '', TRANSCRIPT_RETENTION_BLOBS_PER_PASS) as Array<{detail:string}>;
  expect(plan.map((step) => step.detail).join(' ')).toMatch(/SEARCH blobs USING INDEX/);
  const held = TRANSCRIPT_RETENTION_BLOBS_PER_PASS * 3;
  for (let n = 1; n <= held; n += 1) {
    registerBlob(sqlite, { projectId: 'proj_1', key: key(n), size: 1, receivedAt: 1 });
    sqlite.query(`INSERT INTO tool_calls (project_id, tool_call_id, session_id, event_id, tool_name, input_blob_key, success, created_at, token_id, received_at)
                  VALUES ('proj_1', ?, 's', ?, 'Read', ?, 1, 1, 't', 1)`).run(`tc-${n}`, `e-${n}`, key(n));
  }
  const orphan = key(held + 1);
  registerBlob(sqlite, { projectId: 'proj_1', key: orphan, size: 1, receivedAt: 1 });
  sqlite.query(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 'gone', NULL, 1, 'm')`).run();

  for (let pass = 1; pass <= 3; pass += 1) {
    expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
    expect(cursor(sqlite)).toEqual({ cursor_project: 'proj_1', cursor_key: key(pass * TRANSCRIPT_RETENTION_BLOBS_PER_PASS), revision: pass });
  }
  expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(1);
  expect(sqlite.query(`SELECT 1 FROM blobs WHERE project_id = 'proj_1' AND key = ?`).get(orphan)).toBeNull();
  expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
  expect(cursor(sqlite).cursor_project).toBe('');
});

it('wraps and reaches an orphan inserted behind the committed cursor', async () => {
  const { sqlite, serverEnv } = sqliteEnv();
  const first = key(5);
  registerBlob(sqlite, { projectId: 'proj_1', key: first, size: 1, receivedAt: 1 });
  sqlite.query(`INSERT INTO tool_calls (project_id, tool_call_id, session_id, event_id, tool_name, input_blob_key, success, created_at, token_id, received_at)
                VALUES ('proj_1', 'tc-first', 's', 'e-first', 'Read', ?, 1, 1, 't', 1)`).run(first);
  expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
  const behind = key(2);
  registerBlob(sqlite, { projectId: 'proj_1', key: behind, size: 1, receivedAt: 1 });
  expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
  expect(cursor(sqlite).cursor_project).toBe('');
  expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(1);
});

it('keeps a recent upload available for its event until the reservation window passes', async () => {
  const { sqlite, serverEnv } = sqliteEnv();
  const uploaded = key(9);
  registerBlob(sqlite, { projectId: 'proj_1', key: uploaded, size: 1, receivedAt: NOW });
  expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
  expect(sqlite.query(`SELECT 1 FROM blobs WHERE project_id = 'proj_1' AND key = ?`).get(uploaded)).not.toBeNull();
  expect(await freeOrphanedBlobs(serverEnv, NOW + BLOB_RESERVATION_TTL_MS)).toBe(0);
  expect(await freeOrphanedBlobs(serverEnv, NOW + BLOB_RESERVATION_TTL_MS)).toBe(1);
});
