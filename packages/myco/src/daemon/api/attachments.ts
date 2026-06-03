/**
 * Attachment serving handler — serves attachment bytes from the project-scoped
 * attachments table. There is no disk fallback: attachment bytes live in the
 * vault DB, and the legacy on-disk `attachments/` directory has been archived.
 */

import { getAttachmentByFilePath } from '@myco/db/queries/attachments.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import type { RouteRequest, RouteResponse } from '../router.js';

/** GET /api/.../attachments/:filename — serve an attachment from the vault DB. */
export function createAttachmentHandler() {
  async function handleGetAttachment(req: RouteRequest): Promise<RouteResponse> {
    const filename = req.params.filename;
    // Reject separators so a guessed/crafted name can't reshape the lookup key.
    if (filename.includes('..') || filename.includes('/')) {
      return { status: 400, body: { error: 'invalid_filename' } };
    }

    // Scope MUST come from request context — the attachments table holds rows
    // for every project in the same Grove DB, and an unscoped lookup would
    // return a sibling project's bytes when a caller knows or guesses file_path.
    const scope = projectScopeFromRequestContext(req.requestContext);
    const att = getAttachmentByFilePath(filename, scope);
    if (att?.data) {
      const contentType = att.media_type ?? 'application/octet-stream';
      return { status: 200, headers: { 'Content-Type': contentType }, body: att.data };
    }

    return { status: 404, body: { error: 'not_found' } };
  }

  return { handleGetAttachment };
}
