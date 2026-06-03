/**
 * Attachment serving — DB-only, no disk fallback.
 *
 * Attachment bytes live in the project-scoped attachments table. The legacy
 * on-disk `attachments/` directory has been archived, so the handler must never
 * read from disk — a DB miss is a 404 even if a same-named file exists on disk.
 * (Removing the disk fallback also closes the cross-tenant read it enabled.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAttachmentHandler } from '@myco/daemon/api/attachments';
import { makeTestRequestContext } from '../../helpers/request-context';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import type { RouteRequest } from '@myco/daemon/router';

describe('attachment serving (DB-only)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('does not serve from disk — a DB miss is 404 even if the file exists on disk', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-att-'));
    fs.mkdirSync(path.join(vault, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'attachments', 'photo.png'), 'ON-DISK-BYTES');

    const { handleGetAttachment } = createAttachmentHandler();
    const req = {
      params: { filename: 'photo.png' },
      requestContext: makeTestRequestContext({ vaultDir: vault }),
    } as unknown as RouteRequest;

    const res = await handleGetAttachment(req);
    expect(res.status).toBe(404);
  });

  it('rejects path separators in the filename', async () => {
    const { handleGetAttachment } = createAttachmentHandler();
    const req = {
      params: { filename: '../secret' },
      requestContext: makeTestRequestContext(),
    } as unknown as RouteRequest;

    const res = await handleGetAttachment(req);
    expect(res.status).toBe(400);
  });
});
