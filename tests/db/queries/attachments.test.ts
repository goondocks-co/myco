/**
 * Tests for attachment CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import {
  insertAttachment,
  listAttachmentsBySession,
  getAttachmentByFilePath,
  type AttachmentListRow,
} from '@myco/db/queries/attachments.js';

describe('attachment queries', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('inserts and lists attachments by session', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

    insertAttachment({
      id: 'att-1', session_id: 'sess-1', file_path: 'attachments/abc123-t1-1.png',
      media_type: 'image/png', created_at: now,
    });
    insertAttachment({
      id: 'att-2', session_id: 'sess-1',
      file_path: 'attachments/abc123-t2-1.jpg', media_type: 'image/jpeg', created_at: now,
    });

    const attachments = listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(2);
    expect(attachments[0].file_path).toContain('abc123');
  });

  it('listAttachmentsBySession does not include the data BLOB column', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    insertAttachment({
      id: 'att-1',
      session_id: 'sess-1',
      file_path: 'attachments/image.png',
      media_type: 'image/png',
      data: binaryData,
      content_hash: 'sha256:abc123',
      created_at: now,
    });

    const rows: AttachmentListRow[] = listAttachmentsBySession('sess-1');
    expect(rows).toHaveLength(1);
    // data must not be present on list rows
    expect('data' in rows[0]).toBe(false);
    // metadata fields must still be accessible
    expect(rows[0].content_hash).toBe('sha256:abc123');
    expect(rows[0].file_path).toBe('attachments/image.png');
  });

  it('returns empty array for session with no attachments', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });
    const attachments = listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(0);
  });

  it('insert is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });
    const data = { id: 'att-1', session_id: 'sess-1', file_path: 'test.png', media_type: 'image/png', created_at: now };
    insertAttachment(data);
    insertAttachment(data); // should not throw
    const attachments = listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // data BLOB and content_hash
  // ---------------------------------------------------------------------------

  it('stores and retrieves binary data (Buffer)', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
    const row = insertAttachment({
      id: 'att-1',
      session_id: 'sess-1',
      file_path: 'attachments/image.png',
      media_type: 'image/png',
      data: binaryData,
      content_hash: 'sha256:abc123',
      created_at: now,
    });

    expect(row).not.toBeUndefined();
    expect(row!.data).toBeInstanceOf(Buffer);
    expect(Buffer.compare(row!.data as Buffer, binaryData)).toBe(0);
    expect(row!.content_hash).toBe('sha256:abc123');
  });

  it('stores null data and content_hash when not provided', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

    const row = insertAttachment({
      id: 'att-1',
      session_id: 'sess-1',
      file_path: 'attachments/image.png',
      media_type: 'image/png',
      created_at: now,
    });

    expect(row).not.toBeUndefined();
    expect(row!.data).toBeNull();
    expect(row!.content_hash).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // getAttachmentByFilePath
  // ---------------------------------------------------------------------------

  describe('getAttachmentByFilePath', () => {
    it('returns the attachment matching the given file_path', async () => {
      const now = Math.floor(Date.now() / 1000);
      upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

      insertAttachment({
        id: 'att-1',
        session_id: 'sess-1',
        file_path: 'attachments/screenshot.png',
        media_type: 'image/png',
        content_hash: 'sha256:deadbeef',
        created_at: now,
      });

      const row = getAttachmentByFilePath('attachments/screenshot.png');
      expect(row).not.toBeNull();
      expect(row!.id).toBe('att-1');
      expect(row!.file_path).toBe('attachments/screenshot.png');
      expect(row!.content_hash).toBe('sha256:deadbeef');
    });

    it('returns null for a non-existent file_path', async () => {
      const row = getAttachmentByFilePath('attachments/does-not-exist.png');
      expect(row).toBeNull();
    });

    it('returns the first match when multiple attachments exist', async () => {
      const now = Math.floor(Date.now() / 1000);
      upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

      insertAttachment({
        id: 'att-1',
        session_id: 'sess-1',
        file_path: 'attachments/a.png',
        media_type: 'image/png',
        created_at: now,
      });
      insertAttachment({
        id: 'att-2',
        session_id: 'sess-1',
        file_path: 'attachments/b.png',
        media_type: 'image/png',
        created_at: now,
      });

      const row = getAttachmentByFilePath('attachments/a.png');
      expect(row).not.toBeNull();
      expect(row!.id).toBe('att-1');

      const row2 = getAttachmentByFilePath('attachments/b.png');
      expect(row2).not.toBeNull();
      expect(row2!.id).toBe('att-2');
    });
  });
});
