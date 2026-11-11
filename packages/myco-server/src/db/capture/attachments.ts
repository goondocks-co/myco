/** A captured `attachment` event's row: the blob it names, described as stored, written once under its id when this request stored the event. */
import { write, type Bound } from '../index.js';
import { storedByThisRequest } from './event-write.js';
import type { Stored } from './sessions.js';

const insert = write<[project: string, attachment: string, session: string, prompt: string | null, event: string, description: string | null,
  originPath: string | null, createdAt: number, token: string, receivedAt: number, blob: string, nonce: string], { applied: number }>({ name: 'capture.attachment', sql:
  `INSERT INTO attachments (project_id,attachment_id,session_id,prompt_id,event_id,blob_key,media_type,byte_size,description,origin_path,created_at,token_id,received_at)
    SELECT ?1, ?2, ?3, ?4, ?5, b.key, b.media_type, b.size, ?6, ?7, CAST(?8 AS INTEGER), ?9, CAST(?10 AS INTEGER)
      FROM blobs b WHERE b.project_id=?1 AND b.key=?11 AND ${storedByThisRequest('?1', '?5', '?12')}
    ON CONFLICT (project_id, attachment_id) DO NOTHING RETURNING 1 AS applied` });

export interface AttachmentEvent {
  attachmentId: string; promptId: string | null; description: string | null; originPath: string | null; createdAt: number; token: string;
  receivedAt: number; blob: string;
}

const integer = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error('material_integer_invalid');
  return value;
};

export const attachmentProjection = (s: Stored, a: AttachmentEvent): Bound<{ applied: number }> =>
  insert.bind(s.project, a.attachmentId, s.session, a.promptId, s.event, a.description, a.originPath, integer(a.createdAt), a.token, integer(a.receivedAt), a.blob, s.nonce);
