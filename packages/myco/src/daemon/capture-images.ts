/**
 * Shared image attachment persistence.
 *
 * Called from two paths that both produce the same attachment row shape:
 *
 * 1. `stop-processing.ts` — for claude-code / cursor, where images come from
 *    transcript-mined `TranscriptTurn.images`. The transcript miner has
 *    already decoded base64 blocks and produced a canonical `TranscriptImage`
 *    per image per turn.
 *
 * 2. `event-dispatch.ts` — for opencode, where images come from the plugin
 *    in the `user_prompt` event payload. The opencode plugin extracts each
 *    image from a `FilePart.url` data URL and ships it straight to the
 *    daemon, since opencode has no on-disk transcript to mine.
 *
 * Deterministic IDs (`${sessionShort}-b${promptNumber}-${index}`) keep the
 * insert idempotent under replay: `insertAttachment` uses `ON CONFLICT DO NOTHING`.
 */

import { insertAttachment } from '@myco/db/queries/attachments.js';
import { extensionForMimeType } from '@myco/symbionts/adapter.js';
import { epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { DaemonLogger } from './logger.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

/** Short session-id suffix used in attachment filenames and IDs. */
const SESSION_SHORT_LEN = 6;

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
  logger: DaemonLogger;
  projectId: GroveProjectId;
}

/**
 * Persist a batch of images as attachment rows linked to a specific prompt batch.
 */
export function captureBatchImages(input: CaptureBatchImagesInput): void {
  const { sessionId, promptBatchId, promptNumber, images, logger, projectId } = input;
  if (images.length === 0) return;

  const sessionShort = sessionId.slice(-SESSION_SHORT_LEN);
  for (let j = 0; j < images.length; j++) {
    const img = images[j];
    if (!img?.data || !img?.mediaType) continue;
    try {
      const ext = extensionForMimeType(img.mediaType);
      const filename = `${sessionShort}-t${promptNumber}-${j + 1}.${ext}`;
      const inserted = insertAttachment({
        id: `${sessionShort}-b${promptNumber}-${j + 1}`,
        session_id: sessionId,
        prompt_batch_id: promptBatchId ?? undefined,
        file_path: filename,
        media_type: img.mediaType,
        data: Buffer.from(img.data, 'base64'),
        created_at: epochSeconds(),
        project_id: projectId,
      });
      // insertAttachment returns undefined on ON CONFLICT DO NOTHING — only
      // log when a row was actually inserted, otherwise stop-event replays
      // (or plugin retries) produce phantom "Image stored in DB" lines for
      // attachments that were already persisted.
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
