/**
 * Post-transaction cleanup after a session cascade delete.
 *
 * Shared by the DELETE /api/sessions/:id route and the session-maintenance job
 * to ensure both code paths perform identical cleanup (embedding vectors,
 * vault markdown files, and attachment files on disk).
 */

import { unlink, glob } from 'node:fs/promises';
import { removeBufferLockCompanion } from '@myco/capture/buffer.js';
import type { DeleteCascadeResult } from '../../db/queries/sessions.js';
import type { EmbeddingManager } from '../embedding/manager.js';

/**
 * Remove embedding vectors and vault files for a cascade-deleted session.
 *
 * All operations are best-effort — partial failures are swallowed so that
 * one missing file does not block cleanup of the rest.
 *
 * @param bufferDir - the session's GROVE buffer dir
 *   (`~/.myco/groves/<g>/projects/<p>/buffer/`), resolved by the caller
 *   from its request context or the deleted row's project id. Pass `null`
 *   when unresolvable — the buffer file is then skipped (and logged by the
 *   caller), never guessed: the deletion tombstone already prevents the
 *   lingering file from resurrecting the session.
 */
export async function cleanupAfterSessionCascade(
  sessionId: string,
  result: DeleteCascadeResult,
  embeddingManager: EmbeddingManager,
  vaultDir: string,
  bufferDir: string | null,
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

  // Buffer journal file. Removed alongside DB cascade so a same-id
  // reload doesn't resurrect stale events through reconciliation. Lives
  // under the Grove tree, never the project vault — the caller resolves
  // the real dir or passes null (skip, tombstone keeps it inert).
  if (bufferDir) {
    try { await unlink(`${bufferDir}/${sessionId}.jsonl`); } catch { /* best-effort */ }
    removeBufferLockCompanion(bufferDir, sessionId);
  }
}

/**
 * Cascade cleanup that tolerates an unresolvable vault dir. When the
 * project's vault can't be resolved, vector cleanup still runs and the
 * buffer journal (if its dir resolved) is still removed; only the
 * filesystem passes that need a vault root are skipped — never guessed.
 * The single shared shape for every sweep-style caller (dead-session
 * sweep, phantom reap) so their degraded branches cannot drift apart.
 */
export async function cleanupAfterSessionCascadeOrDegrade(
  sessionId: string,
  result: DeleteCascadeResult,
  embeddingManager: EmbeddingManager,
  vaultDir: string | null,
  bufferDir: string | null,
): Promise<void> {
  if (vaultDir) {
    await cleanupAfterSessionCascade(sessionId, result, embeddingManager, vaultDir, bufferDir);
    return;
  }
  try { embeddingManager.onRemoved('sessions', sessionId); } catch { /* best-effort */ }
  for (const sporeId of result.deletedSporeIds) {
    try { embeddingManager.onRemoved('spores', sporeId); } catch { /* best-effort */ }
  }
  if (bufferDir) {
    try { await unlink(`${bufferDir}/${sessionId}.jsonl`); } catch { /* best-effort */ }
    removeBufferLockCompanion(bufferDir, sessionId);
  }
}
