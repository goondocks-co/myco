/**
 * Shared image attachment persistence.
 *
 * Called from three paths that all produce the same attachment row shape:
 *
 * 1. `stop-processing.ts` — for claude-code / cursor / codex, where images
 *    come from transcript-mined `TranscriptTurn.images`. The transcript miner
 *    has already decoded base64 blocks and produced a canonical
 *    `TranscriptImage` per image per turn.
 *
 * 2. `event-dispatch.ts` — for opencode, where images come from the plugin
 *    in the `user_prompt` event payload. The opencode plugin extracts each
 *    image from a `FilePart.url` data URL and ships it straight to the
 *    daemon, since opencode has no on-disk transcript to mine.
 *
 * 3. `capture/transcript-miner.ts` — the mining/resurrection path, via the
 *    miner's injected `captureImages` sink, for turns whose images only
 *    surface through transcript re-mining (no Stop fired for them).
 *
 * Dedup identity is CONTENT-KEYED: a sha256 over (media type + image bytes),
 * stored in `attachments.content_hash`, scoped per session. The row id keeps
 * the legacy `${sessionShort}-b${promptNumber}-${index}` scheme for display/
 * grouping, but identity no longer depends on prompt_number — walker-batch
 * renumbering between Stops used to mint a fresh id for identical bytes and
 * duplicate the BLOB. Legacy rows (NULL content_hash) are lazily stamped per
 * session before dedup so they participate without a schema migration.
 */

import { createHash } from 'node:crypto';
import {
  insertAttachment,
  findAttachmentBySessionContentHash,
  linkAttachmentToBatchIfUnlinked,
  listAttachmentsMissingContentHash,
  setAttachmentContentHash,
} from '@myco/db/queries/attachments.js';
import { extensionForMimeType } from '@myco/symbionts/adapter.js';
import { epochSeconds, CONTENT_HASH_ALGORITHM } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

/** Short session-id suffix used in attachment filenames and IDs. */
const SESSION_SHORT_LEN = 6;

/**
 * Hex chars of the content hash appended to id/filename when a DISTINCT
 * image collides with an already-occupied (promptNumber, index) slot —
 * both images are kept; the suffix disambiguates the second.
 */
const HASH_SUFFIX_LEN = 8;

/**
 * Minimal logger surface required by this module. `DaemonLogger` satisfies
 * it structurally; the capture-layer caller (transcript miner) injects its
 * own without importing daemon types.
 */
export interface CaptureImagesLogger {
  debug(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

/** Image attachment in canonical base64 form. Matches `TranscriptImage`. */
export interface CapturedImage {
  /** Base64-encoded image bytes. */
  data: string;
  /** MIME type (e.g. `image/png`). */
  mediaType: string;
}

export interface CaptureBatchImagesInput {
  sessionId: string;
  promptBatchId: number | null | undefined;
  promptNumber: number;
  images: CapturedImage[];
  logger: CaptureImagesLogger;
  projectId: GroveProjectId;
}

/** Content identity of an attachment: media type + raw bytes. */
export function attachmentContentHash(mediaType: string, bytes: Buffer): string {
  return createHash(CONTENT_HASH_ALGORITHM)
    .update(mediaType)
    .update('\n')
    .update(bytes)
    .digest('hex');
}

/**
 * Stamp content hashes onto a session's pre-content-keying rows so the
 * dedup lookup sees them. One-time per row: stamped rows never reappear
 * in the missing-hash query. Best-effort — a failure here only weakens
 * dedup for legacy rows, never blocks new captures.
 */
function backfillSessionContentHashes(sessionId: string, logger: CaptureImagesLogger): void {
  try {
    for (const legacy of listAttachmentsMissingContentHash(sessionId)) {
      if (!legacy.data || !legacy.media_type) continue;
      setAttachmentContentHash(legacy.id, attachmentContentHash(legacy.media_type, legacy.data));
    }
  } catch (err) {
    logger.warn(LOG_KINDS.CAPTURE_ATTACHMENT, 'Failed to backfill attachment content hashes', {
      session_id: sessionId,
      error: String(err),
    });
  }
}

/**
 * Persist a batch of images as attachment rows linked to a specific prompt batch.
 */
export function captureBatchImages(input: CaptureBatchImagesInput): void {
  const { sessionId, promptBatchId, promptNumber, images, logger, projectId } = input;
  if (images.length === 0) return;

  backfillSessionContentHashes(sessionId, logger);

  const sessionShort = sessionId.slice(-SESSION_SHORT_LEN);
  for (let j = 0; j < images.length; j++) {
    const img = images[j];
    if (!img?.data || !img?.mediaType) continue;
    try {
      const bytes = Buffer.from(img.data, 'base64');
      const contentHash = attachmentContentHash(img.mediaType, bytes);

      // Content-keyed dedup: the same image in the same session is ONE
      // attachment row, regardless of how prompt_numbers shifted between
      // capture passes (Stop replays, walker renumbering, re-mining). A
      // dedup hit still upgrades batch linkage when the existing row was
      // captured before its batch was known.
      const existing = findAttachmentBySessionContentHash(sessionId, contentHash);
      if (existing) {
        if (existing.prompt_batch_id == null && promptBatchId != null) {
          linkAttachmentToBatchIfUnlinked(existing.id, promptBatchId);
        }
        continue;
      }

      const ext = extensionForMimeType(img.mediaType);
      const slotId = `${sessionShort}-b${promptNumber}-${j + 1}`;
      const slotFilename = `${sessionShort}-t${promptNumber}-${j + 1}.${ext}`;
      const buildRow = (id: string, filename: string) => ({
        id,
        session_id: sessionId,
        prompt_batch_id: promptBatchId ?? undefined,
        file_path: filename,
        media_type: img.mediaType,
        data: bytes,
        content_hash: contentHash,
        created_at: epochSeconds(),
        project_id: projectId,
      });

      let filename = slotFilename;
      let inserted = insertAttachment(buildRow(slotId, slotFilename));
      if (!inserted) {
        // The slot id is occupied by DIFFERENT content (identical content
        // returned above). Keep both images: disambiguate the new one with
        // a content-hash suffix. The `-t{n}-` filename marker stays intact
        // so turn-number grouping keeps working.
        const suffix = contentHash.slice(0, HASH_SUFFIX_LEN);
        filename = `${sessionShort}-t${promptNumber}-${j + 1}-${suffix}.${ext}`;
        inserted = insertAttachment(buildRow(`${slotId}-${suffix}`, filename));
      }

      if (inserted) {
        logger.debug(LOG_KINDS.CAPTURE_ATTACHMENT, 'Image stored in DB', {
          filename,
          batch: promptNumber,
        });
      }
    } catch (err) {
      logger.warn(LOG_KINDS.CAPTURE_ATTACHMENT, 'Failed to record attachment', {
        error: String(err),
      });
    }
  }
}
