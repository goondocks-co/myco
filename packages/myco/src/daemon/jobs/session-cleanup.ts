/**
 * Post-transaction cleanup after a session cascade delete.
 *
 * Shared by the DELETE /api/sessions/:id route and the session-maintenance job
 * to ensure both code paths perform identical cleanup (embedding vectors,
 * vault markdown files, and attachment files on disk).
 */

import { unlink, glob } from 'node:fs/promises';
import type { DeleteCascadeResult } from '../../db/queries/sessions.js';
import type { EmbeddingManager } from '../embedding/manager.js';

/**
 * Remove embedding vectors and vault files for a cascade-deleted session.
 *
 * All operations are best-effort — partial failures are swallowed so that
 * one missing file does not block cleanup of the rest.
 */
export async function cleanupAfterSessionCascade(
  sessionId: string,
  result: DeleteCascadeResult,
  embeddingManager: EmbeddingManager,
  vaultDir: string,
): Promise<void> {
  // Embedding vectors
  try { embeddingManager.onRemoved('sessions', sessionId); } catch { /* best-effort */ }
  for (const sporeId of result.deletedSporeIds) {
    try { embeddingManager.onRemoved('spores', sporeId); } catch { /* best-effort */ }
  }

  // Session markdown
  try {
    for await (const f of glob(`sessions/**/session-${sessionId}.md`, { cwd: vaultDir })) {
      await unlink(`${vaultDir}/${f}`).catch(() => {});
    }
  } catch { /* best-effort */ }

  // Spore markdown files
  for (const sporeId of result.deletedSporeIds) {
    try {
      for await (const f of glob(`spores/**/${sporeId}*.md`, { cwd: vaultDir })) {
        await unlink(`${vaultDir}/${f}`).catch(() => {});
      }
    } catch { /* best-effort */ }
  }

  // Attachment files on disk
  for (const filePath of result.deletedAttachmentPaths) {
    try { await unlink(filePath); } catch { /* best-effort */ }
  }
}
