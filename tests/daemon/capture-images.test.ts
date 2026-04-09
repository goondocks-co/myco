/**
 * Tests for the shared image-attachment persistence helper.
 *
 * Called by both stop-processing.ts (claude-code/cursor transcript path) and
 * event-dispatch.ts (opencode plugin user_prompt path), so the same function
 * must handle both callers' shapes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
