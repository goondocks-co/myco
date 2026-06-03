/**
 * Attachment serving handler — serves attachment files from DB or disk fallback.
 *
 * Factory function injects vaultDir; returns a single route handler for
 * GET /api/attachments/:filename.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAttachmentByFilePath } from '@myco/db/queries/attachments.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Media type lookup for attachment file serving. */
const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachmentDeps {
  vaultDir: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAttachmentHandler(deps: AttachmentDeps) {
  const { vaultDir } = deps;

  /** GET /api/attachments/:filename — serve attachment from DB or disk fallback. */
  async function handleGetAttachment(req: RouteRequest): Promise<RouteResponse> {
    const filename = req.params.filename;
    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return { status: 400, body: { error: 'invalid_filename' } };
    }

    // Try DB first (new path). Scope MUST come from request context — the
    // attachments table holds rows for every project in the same Grove DB
    // and an unscoped lookup would return a sibling project's bytes when
    // a caller knows or guesses the file_path.
    const scope = projectScopeFromRequestContext(req.requestContext);
    const att = getAttachmentByFilePath(filename, scope);
    if (att?.data) {
      const contentType = att.media_type ?? 'application/octet-stream';
      return { status: 200, headers: { 'Content-Type': contentType }, body: att.data };
    }

    // Fallback to disk for pre-migration attachments
    const filePath = path.join(vaultDir, 'attachments', filename);
    let diskData: Buffer;
    try {
      diskData = fs.readFileSync(filePath);
    } catch {
      return { status: 404, body: { error: 'not_found' } };
    }
    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType = ATTACHMENT_MEDIA_TYPES[ext] ?? 'application/octet-stream';
    return { status: 200, headers: { 'Content-Type': contentType }, body: diskData };
  }

  return { handleGetAttachment };
}
