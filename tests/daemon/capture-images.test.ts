/**
 * Tests for the shared image-attachment persistence helper.
 *
 * Called by both stop-processing.ts (claude-code/cursor transcript path) and
 * event-dispatch.ts (opencode plugin user_prompt path), so the same function
 * must handle both callers' shapes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import { captureBatchImages } from '@myco/daemon/capture-images.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';

const epochNow = () => Math.floor(Date.now() / 1000);

/** Minimal logger stub — captures calls without side effects. */
function stubLogger(): DaemonLogger {
  const calls: Array<{ level: string; kind: string; message: string; data?: unknown }> = [];
  const noop = (level: string) => (kind: string, message: string, data?: unknown) => {
    calls.push({ level, kind, message, data });
  };
  return {
    debug: noop('debug'),
    info: noop('info'),
    warn: noop('warn'),
    error: noop('error'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** 1x1 transparent PNG encoded as base64 — smallest valid PNG. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZuUKhUAAAAASUVORK5CYII=';

describe('captureBatchImages', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('inserts an attachment row from a base64 image', () => {
    const sessionId = 'test-captureimg-001';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'opencode', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'look at this',
      started_at: now,
      created_at: now,
    });

    captureBatchImages({
      sessionId,
      promptBatchId: batch.id,
      promptNumber: 1,
      images: [{ data: PNG_1x1, mediaType: 'image/png' }],
      logger: stubLogger(),
    });

    const rows = getDatabase()
      .prepare('SELECT id, session_id, prompt_batch_id, file_path, media_type FROM attachments WHERE session_id = ?')
      .all(sessionId) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_batch_id).toBe(batch.id);
    expect(rows[0].media_type).toBe('image/png');
    expect(String(rows[0].file_path)).toMatch(/\.png$/);
    expect(String(rows[0].file_path)).toMatch(/-t1-1\.png$/); // promptNumber 1, image index 1
    expect(String(rows[0].id)).toMatch(/-b1-1$/);
  });

  it('handles multiple images in a single batch with distinct IDs', () => {
    const sessionId = 'test-captureimg-002';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'opencode', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId,
      prompt_number: 3,
      user_prompt: 'multi',
      started_at: now,
      created_at: now,
    });

    captureBatchImages({
      sessionId,
      promptBatchId: batch.id,
      promptNumber: 3,
      images: [
        { data: PNG_1x1, mediaType: 'image/png' },
        { data: PNG_1x1, mediaType: 'image/jpeg' },
        { data: PNG_1x1, mediaType: 'image/webp' },
      ],
      logger: stubLogger(),
    });

    const rows = getDatabase()
      .prepare('SELECT id, file_path, media_type FROM attachments WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(3);
    // Each image gets a unique ID ending in -b3-{1,2,3}
    expect(rows.map((r) => String(r.id)).every((id) => id.includes('-b3-'))).toBe(true);
    // Extensions reflect the mime types
    expect(rows.map((r) => String(r.file_path))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.png$/),
        expect.stringMatching(/\.jpg$/),
        expect.stringMatching(/\.webp$/),
      ]),
    );
  });

  it('is idempotent under replay — duplicate calls do not create duplicate rows', () => {
    const sessionId = 'test-captureimg-003';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'opencode', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'replay',
      started_at: now,
      created_at: now,
    });

    const image = { data: PNG_1x1, mediaType: 'image/png' };

    // First capture
    captureBatchImages({
      sessionId,
      promptBatchId: batch.id,
      promptNumber: 1,
      images: [image],
      logger: stubLogger(),
    });
    // Same call again — simulates a stop-event replay or plugin retry
    captureBatchImages({
      sessionId,
      promptBatchId: batch.id,
      promptNumber: 1,
      images: [image],
      logger: stubLogger(),
    });

    const rows = getDatabase()
      .prepare('SELECT id FROM attachments WHERE session_id = ?')
      .all(sessionId) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1); // ON CONFLICT DO NOTHING
  });

  it('skips images with missing data or mediaType', () => {
    const sessionId = 'test-captureimg-004';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'opencode', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'partial',
      started_at: now,
      created_at: now,
    });

    captureBatchImages({
      sessionId,
      promptBatchId: batch.id,
      promptNumber: 1,
      images: [
        { data: '', mediaType: 'image/png' }, // empty data — skip
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { data: PNG_1x1, mediaType: '' as any }, // empty mediaType — skip
        { data: PNG_1x1, mediaType: 'image/png' }, // valid
      ],
      logger: stubLogger(),
    });

    const rows = getDatabase()
      .prepare('SELECT id FROM attachments WHERE session_id = ?')
      .all(sessionId) as Array<Record<string, unknown>>;

    // Only the valid image landed. Note: the first two skipped images mean the
    // valid image at index 2 lands with index suffix -b1-3 (1-based j+1).
    expect(rows).toHaveLength(1);
  });

  it('no-ops on empty images array', () => {
    const sessionId = 'test-captureimg-005';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'opencode', started_at: now, created_at: now });

    captureBatchImages({
      sessionId,
      promptBatchId: null,
      promptNumber: 1,
      images: [],
      logger: stubLogger(),
    });

    const rows = getDatabase()
      .prepare('SELECT id FROM attachments WHERE session_id = ?')
      .all(sessionId);

    expect(rows).toHaveLength(0);
  });

  it('allows null promptBatchId (fallback path for transcript-mined images without matched batch)', () => {
    const sessionId = 'test-captureimg-006';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    captureBatchImages({
      sessionId,
      promptBatchId: null,
      promptNumber: 5,
      images: [{ data: PNG_1x1, mediaType: 'image/png' }],
      logger: stubLogger(),
    });

    const rows = getDatabase()
      .prepare('SELECT id, prompt_batch_id FROM attachments WHERE session_id = ?')
      .all(sessionId) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_batch_id).toBeNull();
  });
});

/**
 * RC-D — content-keyed attachment identity. Dedup keys on a sha256 of
 * (media type + bytes) per session, NOT on (prompt_number, index): walker
 * renumbering between Stops used to mint a fresh prompt-number id for
 * identical bytes and duplicate the BLOB (production: 3 duplicate rows).
 */
describe('captureBatchImages — content-keyed identity (RC-D)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  /** A second, distinct valid base64 payload (different bytes than PNG_1x1). */
  const PNG_OTHER = Buffer.from('not-actually-a-png-but-distinct-bytes-1').toString('base64');

  const rowsFor = (sessionId: string) =>
    getDatabase()
      .prepare('SELECT id, file_path, prompt_batch_id, content_hash FROM attachments WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as Array<Record<string, unknown>>;

  it('same content captured under a renumbered prompt → ONE attachment row', () => {
    const sessionId = 'test-captureimg-renumber';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId, prompt_number: 2, user_prompt: 'with image',
      started_at: now, created_at: now,
    });

    const image = { data: PNG_1x1, mediaType: 'image/png' };

    // Stop 1: captured at prompt_number 2.
    captureBatchImages({ sessionId, promptBatchId: batch.id, promptNumber: 2, images: [image], logger: stubLogger() });
    // Walker renumbering between Stops: same image re-captured at 3.
    captureBatchImages({ sessionId, promptBatchId: batch.id, promptNumber: 3, images: [image], logger: stubLogger() });

    const rows = rowsFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].content_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different images at the same prompt_number slot → both kept', () => {
    const sessionId = 'test-captureimg-distinct';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId, prompt_number: 1, user_prompt: 'two captures',
      started_at: now, created_at: now,
    });

    captureBatchImages({
      sessionId, promptBatchId: batch.id, promptNumber: 1,
      images: [{ data: PNG_1x1, mediaType: 'image/png' }], logger: stubLogger(),
    });
    // Renumbering swapped slots: a DIFFERENT image now claims (1, 1).
    captureBatchImages({
      sessionId, promptBatchId: batch.id, promptNumber: 1,
      images: [{ data: PNG_OTHER, mediaType: 'image/png' }], logger: stubLogger(),
    });

    const rows = rowsFor(sessionId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => String(r.id))).size).toBe(2);
    expect(new Set(rows.map((r) => String(r.file_path))).size).toBe(2);
    // The disambiguated row keeps the parseable -t{n}- marker.
    for (const r of rows) expect(String(r.file_path)).toMatch(/-t1-/);
  });

  it('legacy rows (NULL content_hash) are lazily stamped and participate in dedup', () => {
    const sessionId = 'test-captureimg-legacy';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId, prompt_number: 1, user_prompt: 'legacy',
      started_at: now, created_at: now,
    });

    // A pre-content-keying row: prompt-number id, BLOB present, hash NULL.
    getDatabase().prepare(
      `INSERT INTO attachments (id, session_id, prompt_batch_id, file_path, media_type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-b1-1', sessionId, batch.id, 'legacy-t1-1.png', 'image/png', Buffer.from(PNG_1x1, 'base64'), now);

    // Re-capture of the SAME bytes under a different prompt number (the
    // duplication class) must dedup against the freshly-stamped legacy row.
    captureBatchImages({
      sessionId, promptBatchId: batch.id, promptNumber: 4,
      images: [{ data: PNG_1x1, mediaType: 'image/png' }], logger: stubLogger(),
    });

    const rows = rowsFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe('legacy-b1-1');
    expect(String(rows[0].content_hash)).toMatch(/^[0-9a-f]{64}$/); // stamped
  });

  it('a dedup hit upgrades missing batch linkage instead of dropping it', () => {
    const sessionId = 'test-captureimg-linkup';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', started_at: now, created_at: now });
    const batch = insertBatch({
      session_id: sessionId, prompt_number: 1, user_prompt: 'late linkage',
      started_at: now, created_at: now,
    });

    const image = { data: PNG_1x1, mediaType: 'image/png' };
    // First capture before the batch was known.
    captureBatchImages({ sessionId, promptBatchId: null, promptNumber: 1, images: [image], logger: stubLogger() });
    // Re-capture once matched to a batch.
    captureBatchImages({ sessionId, promptBatchId: batch.id, promptNumber: 1, images: [image], logger: stubLogger() });

    const rows = rowsFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_batch_id).toBe(batch.id);
  });
});
