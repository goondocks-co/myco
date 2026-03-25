/**
 * Tests for attachment CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertAttachment, listAttachmentsBySession } from '@myco/db/queries/attachments.js';

describe('attachment queries', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  it('inserts and lists attachments by session', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

    await insertAttachment({
      id: 'att-1', session_id: 'sess-1', file_path: 'attachments/abc123-t1-1.png',
      media_type: 'image/png', created_at: now,
    });
    await insertAttachment({
      id: 'att-2', session_id: 'sess-1',
      file_path: 'attachments/abc123-t2-1.jpg', media_type: 'image/jpeg', created_at: now,
    });

    const attachments = await listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(2);
    expect(attachments[0].file_path).toContain('abc123');
  });

  it('returns empty array for session with no attachments', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });
    const attachments = await listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(0);
  });

  it('insert is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });
    const data = { id: 'att-1', session_id: 'sess-1', file_path: 'test.png', media_type: 'image/png', created_at: now };
    await insertAttachment(data);
    await insertAttachment(data); // should not throw
    const attachments = await listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(1);
  });
});
