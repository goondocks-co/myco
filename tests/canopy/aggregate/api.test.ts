/**
 * Tests for the read-side Canopy daemon HTTP handlers.
 *
 * Each handler is a pure function over a RouteRequest, so we can call them
 * directly without spinning up the HTTP server.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { materializeCanopyAggregates } from '@myco/canopy/aggregate.js';
import {
  handleGetSessionCanopy,
  handleGetCanopyToolCallBlob,
  handleGetCanopyRollup,
} from '@myco/daemon/api/canopy-read.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';

const PROJECT_ID = '/repo/myco';
const epochNow = () => Math.floor(Date.now() / 1000);

function makeReq(opts: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
} = {}): RouteRequest {
  return {
    body: opts.body ?? null,
    query: opts.query ?? {},
    params: opts.params ?? {},
    pathname: '/test',
    requestContext: TEST_REQUEST_CONTEXT,
  };
}

function seedSession(sessionId: string) {
  const now = epochNow();
  upsertSession({
    id: sessionId,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    project_root: PROJECT_ID,
  });
}

function seedRead(
  sessionId: string,
  filePath: string,
  injectionTokens: number | null,
  ts: number,
): number {
  const result = getDatabase()
    .prepare(`
      INSERT INTO activities (
        session_id, tool_name, tool_input, file_path, timestamp,
        processed, created_at, canopy_injection_tokens
      ) VALUES (?, 'Read', ?, ?, ?, 0, ?, ?)
    `)
    .run(sessionId, JSON.stringify({ file_path: filePath }), filePath, ts, ts, injectionTokens);
  return Number(result.lastInsertRowid);
}

function seedCanopyEntry(path: string, tokens: number) {
  const now = epochNow();
  getDatabase()
    .prepare(`
      INSERT INTO canopy_entries (
        project_id, machine_id, path, content_hash, size_bytes, token_estimate,
        line_count, language, exports_json, imports_json, top_comment,
        mechanical_updated_at, llm_description, llm_updated_at
      ) VALUES (?, 'local', ?, 'h', 0, ?, 0, 'typescript', '["foo"]', '[]', NULL, ?, NULL, NULL)
    `)
    .run(PROJECT_ID, path, tokens, now);
}

describe('handleGetSessionCanopy', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('returns 404 when the session does not exist', async () => {
    const res = await handleGetSessionCanopy(makeReq({ params: { id: 'missing' } }));
    expect(res.status).toBe(404);
  });

  it('returns the flat aggregate for a session with data', async () => {
    const sessionId = 'sess-api-1';
    seedSession(sessionId);
    seedCanopyEntry('a.ts', 1000);
    seedRead(sessionId, 'a.ts', 80, epochNow());
    materializeCanopyAggregates(sessionId);

    const res = await handleGetSessionCanopy(makeReq({ params: { id: sessionId } }));
    expect(res.status ?? 200).toBe(200);
    const body = res.body as Record<string, number | null>;
    expect(body.canopy_injections_offered).toBe(1);
    expect(body.canopy_tokens_saved).toBe(920);
  });

  it('returns NULL fields for a pre-feature session', async () => {
    const sessionId = 'sess-api-prefeature';
    seedSession(sessionId);
    // Don't materialize → all canopy columns stay NULL.

    const res = await handleGetSessionCanopy(makeReq({ params: { id: sessionId } }));
    const body = res.body as Record<string, number | null>;
    expect(body.canopy_injections_offered).toBeNull();
    expect(body.canopy_tokens_saved).toBeNull();
  });
});

describe('handleGetCanopyToolCallBlob', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('returns 404 when the tool-call does not belong to the session', async () => {
    const sessionId = 'sess-api-blob-1';
    seedSession(sessionId);
    const res = await handleGetCanopyToolCallBlob(makeReq({
      params: { id: sessionId, tcId: '99999' },
    }));
    expect(res.status).toBe(404);
  });

  it('returns 400 on a non-numeric tcId', async () => {
    const res = await handleGetCanopyToolCallBlob(makeReq({
      params: { id: 'whatever', tcId: 'not-a-number' },
    }));
    expect(res.status).toBe(400);
  });

  it('returns 404 entry_missing when the canopy_entries row is gone', async () => {
    const sessionId = 'sess-api-blob-2';
    seedSession(sessionId);
    const tcId = seedRead(sessionId, 'gone.ts', 80, epochNow());

    const res = await handleGetCanopyToolCallBlob(makeReq({
      params: { id: sessionId, tcId: String(tcId) },
    }));
    expect(res.status).toBe(404);
    const body = res.body as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('not_found');
    expect(body.error?.message).toBe('entry_missing');
  });

  it('returns 404 for a Read that did not receive a Canopy injection', async () => {
    const sessionId = 'sess-api-blob-no-injection';
    seedSession(sessionId);
    seedCanopyEntry('present.ts', 800);
    const tcId = seedRead(sessionId, 'present.ts', null, epochNow());

    const res = await handleGetCanopyToolCallBlob(makeReq({
      params: { id: sessionId, tcId: String(tcId) },
    }));
    expect(res.status).toBe(404);
  });

  it('canonicalizes absolute tool-call paths for blob lookup', async () => {
    const sessionId = 'sess-api-blob-absolute';
    seedSession(sessionId);
    seedCanopyEntry('present.ts', 800);
    const tcId = seedRead(sessionId, `${PROJECT_ID}/present.ts`, 70, epochNow());

    const res = await handleGetCanopyToolCallBlob(makeReq({
      params: { id: sessionId, tcId: String(tcId) },
    }));
    expect(res.status ?? 200).toBe(200);
    const body = res.body as { blob: string };
    expect(body.blob).toContain('[canopy] present.ts');
  });

  it('returns the verbatim composed blob when canopy_entries row exists', async () => {
    const sessionId = 'sess-api-blob-3';
    seedSession(sessionId);
    seedCanopyEntry('present.ts', 800);
    const tcId = seedRead(sessionId, 'present.ts', 70, epochNow());

    const res = await handleGetCanopyToolCallBlob(makeReq({
      params: { id: sessionId, tcId: String(tcId) },
    }));
    const body = res.body as { blob: string };
    // The endpoint must return the same string composeBlob() produces — same
    // freshness gate, same caps, same [meta] line. The popover renders this
    // verbatim, so the wire shape is just the string.
    expect(typeof body.blob).toBe('string');
    expect(body.blob).toContain('[canopy] present.ts — 800 tok');
    expect(body.blob).toContain('exports: foo');
    // No fresh llm_description seeded → anatomy meta line, not summary meta.
    expect(body.blob).toContain('[meta] File anatomy from Myco');
    expect(body.blob).not.toContain('[meta] File summary from Myco');
  });
});

describe('handleGetCanopyRollup', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('returns the cross-session rollup', async () => {
    const db = getDatabase();
    const now = epochNow();
    upsertSession({ id: 's1', agent: 'claude-code', started_at: now, created_at: now });
    db.prepare(`
      UPDATE sessions SET
        canopy_injections_offered = 4,
        canopy_injection_total_tokens = 300,
        canopy_skips_after_injection = 3,
        canopy_reads_after_injection = 1,
        canopy_tokens_saved = 1200,
        canopy_redundant_reads = 0
      WHERE id = ?
    `).run('s1');

    const res = await handleGetCanopyRollup(makeReq());
    const body = res.body as Record<string, number | null>;
    expect(body.sessions_with_canopy).toBe(1);
    expect(body.total_tokens_saved).toBe(1200);
    expect(body.avg_tokens_saved_per_session).toBe(1200);
    expect(body.injection_effectiveness_ratio).toBeCloseTo(0.75, 5);
    expect(body.total_injections_offered).toBe(4);
    expect(body.total_skips_after_injection).toBe(3);
  });

  it('parses since/until query params', async () => {
    const db = getDatabase();
    upsertSession({ id: 'old', agent: 'claude-code', started_at: 100, created_at: 100 });
    upsertSession({ id: 'new', agent: 'claude-code', started_at: 500, created_at: 500 });
    db.prepare(`
      UPDATE sessions SET canopy_injections_offered = 1, canopy_skips_after_injection = 1,
        canopy_injection_total_tokens = 0, canopy_reads_after_injection = 0,
        canopy_tokens_saved = 50, canopy_redundant_reads = 0
      WHERE id = ?
    `).run('old');
    db.prepare(`
      UPDATE sessions SET canopy_injections_offered = 1, canopy_skips_after_injection = 1,
        canopy_injection_total_tokens = 0, canopy_reads_after_injection = 0,
        canopy_tokens_saved = 90, canopy_redundant_reads = 0
      WHERE id = ?
    `).run('new');

    const res = await handleGetCanopyRollup(makeReq({ query: { since: '300' } }));
    const body = res.body as Record<string, number | null>;
    expect(body.sessions_with_canopy).toBe(1);
    expect(body.total_tokens_saved).toBe(90);
  });
});
