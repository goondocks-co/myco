import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { assertion, first, read, write, refusalCode } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import { objectJournalSql } from '../storage/object-journal.js';

/**
 * An event's payload held whole in the object store, registered in the commit that stores the event: the event row,
 * the content registration and its proof land together or none do. A proof names the body for its event, and holds its
 * object for as long as the event stands.
 */
export const eventBodyUnregistered = refusalCode('event_body_unregistered');

/** The content of one event's payload, verified in the store before the event commits. */
export interface EventBody {
  projectId: string; eventId: string; sessionId: string; tokenId: string; envelopeHash: string; nonce: string;
  key: string; size: number; generation: string | null;
  /** Held only when this request stored the object: the reservation that owns it and its object name. */
  upload?: { reservation: string; physical: string };
}

const STORED = `EXISTS(SELECT 1 FROM events WHERE project_id=?1 AND event_id=?2 AND ingest_nonce=?3)`;

type Stored = [project: string, event: string, nonce: string];

const journalSuperseded = write<[...Stored, physical: string, now: number, key: string]>({ name: 'events.journalSupersededBody', sql:
  objectJournalSql(`SELECT ?4,'upload',?5 WHERE ${STORED} AND EXISTS(SELECT 1 FROM blobs WHERE project_id=?1 AND key=?6)`) });
const register = write<[...Stored, key: string, size: number, token: string, now: number, generation: string | null]>({ name: 'events.registerBody', sql:
  `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    SELECT ?1,?4,?5,'application/json',?6,?7,?8 WHERE ${STORED} ON CONFLICT(project_id,key) DO NOTHING` });
const proof = write<[...Stored, key: string, envelopeHash: string, session: string, size: number, now: number]>({ name: 'events.proveBody', sql:
  `INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    SELECT ?1,?4,b.generation,'event',?2,?2,?5,?6,?4,?7,?8,1 FROM blobs b WHERE b.project_id=?1 AND b.key=?4 AND b.size=?7 AND ${STORED}
    ON CONFLICT DO NOTHING` });
const provenStored = assertion<[...Stored, key: string, size: number]>({ name: 'events.bodyProvenWhenStored', refusal: eventBodyUnregistered,
  when: `NOT ${STORED} OR EXISTS(SELECT 1 FROM registered_content_proofs WHERE project_id=?1 AND source_kind='event' AND source_id=?2 AND key=?4 AND digest=?4 AND size=?5 AND durable=1)` });
const consumeAuthority = write<[...Stored, reservation: string]>({ name: 'events.consumeBodyAuthority', sql:
  `DELETE FROM blob_reservations WHERE reservation_id=?4 AND ${STORED}` });
const clearIntent = write<[...Stored, physical: string]>({ name: 'events.clearBodyIntent', sql:
  `DELETE FROM object_settlement_intents WHERE physical=?4 AND ${STORED}` });

/** The statements after the raw insert that settle a verified body: every one takes effect only when this request stored the event. */
export function eventBodyStatements(db: RelationalStore, body: EventBody, now: number): PreparedStatement[] {
  const held: Stored = [body.projectId, body.eventId, body.nonce];
  const { key, size, upload } = body;
  const uploaded = upload === undefined ? [] : [
    journalSuperseded.bind(...held, upload.physical, now, key),
    register.bind(...held, key, size, body.tokenId, now, upload.reservation),
  ];
  const settled = upload === undefined ? [] : [
    consumeAuthority.bind(...held, upload.reservation),
    clearIntent.bind(...held, upload.physical),
  ];
  return [...uploaded,
    proof.bind(...held, key, body.envelopeHash, body.sessionId, size, now),
    provenStored.bind(...held, key, size),
    ...settled].map(bound => prepareBound(db, bound));
}

/** What the raw insert requires of a body: the upload authority still stands, or the bytes are still registered as they were verified. */
export function eventBodyAdmission(body: EventBody): { sql: string; params: unknown[] } {
  return body.upload === undefined
    ? { sql: 'EXISTS (SELECT 1 FROM blobs WHERE project_id = ? AND key = ? AND generation IS ? AND size = ?)', params: [body.projectId, body.key, body.generation, body.size] }
    : { sql: 'EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id = ? AND project_id = ? AND key = ? AND size = ?)', params: [body.upload.reservation, body.projectId, body.key, body.size] };
}

const reservationHeld = read<[reservation: string, project: string, key: string, size: number], { held: number }>({ name: 'events.bodyReservationHeld', sql:
  'SELECT EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?1 AND project_id=?2 AND key=?3 AND size=?4) AS held' });
const registrationHeld = read<[project: string, key: string, generation: string | null, size: number], { held: number }>({ name: 'events.bodyRegistrationHeld', sql:
  'SELECT EXISTS(SELECT 1 FROM blobs WHERE project_id=?1 AND key=?2 AND generation IS ?3 AND size=?4) AS held' });

/** Read in the event's batch: whether the body the raw insert required still stands, so a lost body is told apart from a refused event. */
export function eventBodyHeldRead(db: RelationalStore, body: EventBody): PreparedStatement {
  return prepareBound(db, body.upload === undefined
    ? registrationHeld.bind(body.projectId, body.key, body.generation, body.size)
    : reservationHeld.bind(body.upload.reservation, body.projectId, body.key, body.size));
}

/** One stored event's content row and, when its payload is in the object store, the object's identity from its proof. */
interface StoredEvent {
  payload: string; payload_format: string; envelope_hash: string; token_id: string; bundle_id: number | null; bundle_entry: number | null;
  body_key: string | null; body_generation: string | null; body_size: number | null;
}
const storedEventRead = read<[project: string, event: string], StoredEvent>({ name: 'events.storedContent', sql:
  `SELECT e.payload,e.payload_format,e.envelope_hash,e.token_id,e.bundle_id,e.bundle_entry,p.key AS body_key,p.generation AS body_generation,p.size AS body_size
    FROM events e LEFT JOIN registered_content_proofs p ON p.project_id=e.project_id AND p.source_kind='event' AND p.source_id=e.event_id
      AND e.payload_format='blob' AND p.event_id=e.event_id AND p.envelope_hash=e.envelope_hash AND p.digest=p.key
    WHERE e.project_id=?1 AND e.event_id=?2` });
export function storedEvent(db: RelationalStore, project: string, event: string): Promise<StoredEvent | null> {
  return first(db, storedEventRead.bind(project, event));
}
