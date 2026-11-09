import type { ContentStore, RelationalStore } from './adapters.js';
import { blobObjectKey } from './blob-objects.js';
import { admitDerivedUpload, contentRegistration, durableProofHeld, type DerivedAuthority } from '../db/storage/content-lifecycle.js';
import { settleUpload } from '../db/storage/object-lifecycle.js';
import { type EventBody } from '../db/events/body.js';
import { BLOB_RESERVATION_TTL_MS } from '../constants.js';
import { sha256HexOf } from '../hash.js';
import { emit } from '../telemetry.js';
import { verifyContentObject } from './registered-content.js';

interface PayloadSource {
  projectId: string; sessionId: string; eventId: string; tokenId: string; envelopeHash: string; nonce: string;
  payload: Uint8Array<ArrayBuffer>;
}

/** Definite answers that a registered object can never serve this payload; any other failure may pass on a retry. */
const UNREADABLE_REGISTRATION: ReadonlySet<string> = new Set([
  'content_registration_unverified', 'content_archive_missing', 'content_archive_size_mismatch', 'content_archive_digest_mismatch',
]);

/**
 * Makes one event's payload durable in the object store and verifies it, without registering it: the event's commit
 * registers it, or the settlement after that commit's failure consumes the authority. Every exit keeps an owner for the bytes.
 * Answers null when these bytes are registered but the stored object definitely cannot serve them: the event then stores inline, so it never retries against an object that stays lost.
 */
export async function prepareEventBody(env: Pick<ContentStore, 'db' | 'blobs'>, source: PayloadSource, now: number): Promise<EventBody | null> {
  const db = env.db;
  const { projectId, sessionId, eventId, tokenId, envelopeHash, nonce, payload } = source;
  const key = await sha256HexOf(payload);
  const size = payload.byteLength;
  const body = { projectId, eventId, sessionId, tokenId, envelopeHash, nonce, key, size };
  const existing = await contentRegistration(db, projectId, key);
  if (existing !== null) {
    try {
      if (existing.size !== size) throw new Error('content_registration_unverified');
      const physical = blobObjectKey(projectId, key, existing.generation);
      if (!await durableProofHeld(db, projectId, key, existing.generation, size) && await env.blobs.ensureDurable?.(physical) !== true) throw new Error('content_durability_unavailable');
      await verifyContentObject(env, physical, size, key);
    } catch (error) {
      if (!(error instanceof Error) || !UNREADABLE_REGISTRATION.has(error.message)) throw error;
      emit({ kind: 'event_body_registration_unreadable', projectId });
      return null;
    }
    return { ...body, generation: existing.generation };
  }
  const reservation = crypto.randomUUID();
  const authority: DerivedAuthority = { projectId, key, size, tokenId, sessionId, eventId, envelopeHash, sourceKind: 'event', sourceId: eventId };
  const physical = await admitDerivedUpload(db, [], reservation, authority, now + BLOB_RESERVATION_TTL_MS, now);
  let stored = false;
  try {
    const object = await env.blobs.put(physical, new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }),
      { size, sha256: key, httpMetadata: { contentType: 'application/json' } });
    stored = true;
    if (object.durable !== true) throw new Error('content_durability_unavailable');
    if (object.size !== size) throw new Error('content_archive_size_mismatch');
    await verifyContentObject(env, physical, size, key);
  } catch (error) {
    await settleUpload(db, { reservation, physical, authorityConsumed: false, stored }, now);
    throw error;
  }
  return { ...body, generation: reservation, upload: { reservation, physical } };
}

/**
 * Consumes the authority of a body whose event did not store it. A failure here leaves the reservation and intent
 * standing for the drain, so it never changes the answer to the caller.
 */
export async function settleUnstoredEventBody(db: RelationalStore, body: EventBody, now: number): Promise<void> {
  if (body.upload === undefined) return;
  try {
    await settleUpload(db, { reservation: body.upload.reservation, physical: body.upload.physical, authorityConsumed: false, stored: true }, now);
  } catch {
    emit({ kind: 'event_body_settlement_failed', projectId: body.projectId });
  }
}
