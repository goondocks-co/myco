import type { RelationalStore } from '../../core/adapters.js';
import { rawCredentialOwner } from '../raw/provenance.js';
import { assertion, commitAfter, commitNamed, read, readSet, write, refusalCode, type BatchGuard } from '../index.js';
import { objectJournalSql } from './object-journal.js';
import { clearSettledIntent, beginUploadIntentStatement } from './object-lifecycle.js';

/**
 * One lifecycle for stored content: an upload authority is taken and a settlement intent names its object before any
 * byte moves, a commit registers the bytes and consumes the authority, and every other exit leaves the authority's
 * consumption or an intent to the release owner. A member's upload and a server-derived body differ only in who
 * authorizes the bytes; both register through these statements.
 */
const contentReservationRefused = refusalCode('content_reservation_refused');
const contentRegistrationGone = refusalCode('content_registration_gone');

export interface ContentRegistration { size: number; media_type: string; generation: string | null }
const registration = read<[project: string, key: string], ContentRegistration>({ name: 'storage.contentRegistration', sql:
  'SELECT size,media_type,generation FROM blobs WHERE project_id=?1 AND key=?2' });
/** What registers `key` in the Project now, or null. */
export async function contentRegistration(db: RelationalStore, project: string, key: string): Promise<ContentRegistration | null> {
  const [[row]] = await readSet(db, registration.bind(project, key));
  return row ?? null;
}

const memberOfCredential = read<[token: string], { member_id: string }>({ name: 'storage.credentialMember', sql: 'SELECT member_id FROM member_credentials WHERE id=?1' });
/** The member holding a credential, or null when it is unknown. */
export async function credentialMember(db: RelationalStore, token: string): Promise<string | null> {
  const [[row]] = await readSet(db, memberOfCredential.bind(token));
  return row?.member_id ?? null;
}

const durableProof = read<[project: string, key: string, generation: string | null, size: number], { held: number }>({ name: 'storage.contentDurableProof', sql:
  'SELECT 1 AS held FROM registered_content_proofs WHERE project_id=?1 AND key=?2 AND generation IS ?3 AND digest=?2 AND size=?4 AND durable=1 LIMIT 1' });
/** Whether a proof already holds this exact registration as durable. */
export async function durableProofHeld(db: RelationalStore, project: string, key: string, generation: string | null, size: number): Promise<boolean> {
  const [rows] = await readSet(db, durableProof.bind(project, key, generation, size));
  return rows.length === 1;
}

/** The one registration statement: while the authority is live it registers the bytes under the authority's own generation, and a key already registered keeps its row. */
const registerContent = write<[project: string, key: string, size: number, mediaType: string, token: string, at: number, reservation: string]>({ name: 'storage.registerContent', sql:
  `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?7 AND expires_at>?6)
    ON CONFLICT(project_id,key) DO NOTHING` });
const proof = write<[project: string, key: string, generation: string | null, sourceKind: string, sourceId: string, eventId: string, envelopeHash: string, session: string, size: number, at: number]>({ name: 'storage.recordContentProof', sql:
  `INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?2,?9,?10,1) ON CONFLICT DO NOTHING` });
const consumeAuthority = write<[reservation: string]>({ name: 'storage.consumeContentAuthority', sql: 'DELETE FROM blob_reservations WHERE reservation_id=?1' });
const blobRegistered = assertion<[project: string, key: string, generation: string | null, size: number]>({ name: 'storage.contentRegistered', refusal: contentRegistrationGone,
  when: 'EXISTS(SELECT 1 FROM blobs WHERE project_id=?1 AND key=?2 AND generation IS ?3 AND size=?4)' });

const creditBytes = write<[size: number, token: string, project: string, key: string, generation: string]>({ name: 'storage.creditUploadBytes', sql:
  'UPDATE member_credentials SET bytes_written=bytes_written+?1 WHERE id=?2 AND EXISTS(SELECT 1 FROM blobs WHERE project_id=?3 AND key=?4 AND generation=?5)' });
const blobRawReference = write<[project: string, key: string, token: string, reservation: string, at: number]>({ name: 'storage.recordUploadProvenance', sql:
  `INSERT INTO raw_resources(project_id,kind,resource_id,reference_id,owner_member_id,machine_id,token_id,revision)
    SELECT ?1,'blob',?2,c.id,${rawCredentialOwner('c.id')},c.machine_id,c.id,(SELECT revision+1 FROM raw_provenance_state WHERE id=1) FROM member_credentials c
      WHERE c.id=?3 AND c.machine_id IS NOT NULL AND c.revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?4 AND expires_at>?5)
        AND EXISTS(SELECT 1 FROM blobs WHERE project_id=?1 AND key=?2) ON CONFLICT DO NOTHING` });
const journalUnpublished = write<[physical: string, at: number, reservation: string, project: string, key: string]>({ name: 'storage.journalUnpublishedUpload', sql:
  objectJournalSql(`SELECT ?1,'upload',?2 WHERE EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?3)
    AND (NOT EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?3 AND expires_at>?2) OR EXISTS(SELECT 1 FROM blobs WHERE project_id=?4 AND key=?5))`) });

export interface MemberUpload { physical: string; reservation: string; projectId: string; key: string; size: number; mediaType: string; tokenId: string; at: number }

/**
 * Publishes a stored member upload: registers it and consumes its authority, or journals its bytes when another upload
 * registered the key first or the authority lapsed, and resolves its settlement intent, in one commit. Answers what
 * registers the key afterwards.
 */
export async function publishMemberUpload(db: RelationalStore, upload: MemberUpload): Promise<ContentRegistration | null> {
  const { physical, reservation, projectId, key, size, mediaType, tokenId, at } = upload;
  const { current } = await commitNamed(db, {
    journal: journalUnpublished.bind(physical, at, reservation, projectId, key),
    register: registerContent.bind(projectId, key, size, mediaType, tokenId, at, reservation),
    bytes: creditBytes.bind(size, tokenId, projectId, key, reservation),
    provenance: blobRawReference.bind(projectId, key, tokenId, reservation, at),
    consume: consumeAuthority.bind(reservation),
    settled: clearSettledIntent.bind(physical),
    current: registration.bind(projectId, key),
  });
  return current.results[0] ?? null;
}

/** Who authorized a server-derived body, as a proof records it. */
export interface DerivedAuthority {
  projectId: string; key: string; size: number; tokenId: string; sessionId: string; eventId: string; envelopeHash: string; sourceKind: string; sourceId: string;
}

const reserveDerived = write<[reservation: string, project: string, key: string, token: string, size: number, expires: number, sourceKind: string, sourceId: string, eventId: string, envelopeHash: string, session: string], { reservation_id: string }>({ name: 'storage.reserveDerivedContent', sql:
  `INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at,authority_kind,source_kind,source_id,source_event_id,source_envelope_hash,source_session_id)
    VALUES(?1,?2,?3,?4,?5,?6,'server',?7,?8,?9,?10,?11) RETURNING reservation_id` });

/**
 * Takes the authority for a derived body under the caller's admission guards and names its object in one commit, so
 * the object has an owner before a byte is written. Answers its physical key.
 */
export async function admitDerivedUpload(db: RelationalStore, guards: readonly BatchGuard[], generation: string, authority: DerivedAuthority, expires: number, now: number): Promise<string> {
  const { projectId, key, tokenId, size, sourceKind, sourceId, eventId, envelopeHash, sessionId } = authority;
  const [reserved, intent] = await commitAfter(db, guards,
    reserveDerived.bind(generation, projectId, key, tokenId, size, expires, sourceKind, sourceId, eventId, envelopeHash, sessionId),
    beginUploadIntentStatement.bind(generation, now));
  const physical = intent.results[0]?.physical;
  if (reserved.results.length !== 1 || physical === undefined) throw new Error('content_reservation_refused');
  return physical;
}

const reservationStands = assertion<[generation: string, project: string, key: string, size: number, token: string, session: string, liveAt: number, sourceKind: string, sourceId: string, eventId: string, envelopeHash: string]>({
  name: 'storage.derivedReservationStands', refusal: contentReservationRefused, when: `EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?1
    AND project_id=?2 AND key=?3 AND size=?4 AND token_id=?5 AND source_session_id=?6 AND expires_at>?7
    AND authority_kind='server' AND source_kind=?8 AND source_id=?9 AND source_event_id=?10 AND source_envelope_hash=?11)` });

/**
 * Registers a verified derived body with its durable proof, consumes its authority and resolves its intent, in one
 * commit under the caller's source and publication guards.
 */
export async function publishDerivedUpload(db: RelationalStore, guards: readonly BatchGuard[], published: { generation: string; physical: string; authority: DerivedAuthority; now: number; liveAt: number }): Promise<void> {
  const { generation, physical, authority, now, liveAt } = published;
  const { projectId, key, size, tokenId, sessionId, sourceKind, sourceId, eventId, envelopeHash } = authority;
  await commitAfter(db, guards,
    reservationStands.bind(generation, projectId, key, size, tokenId, sessionId, liveAt, sourceKind, sourceId, eventId, envelopeHash),
    registerContent.bind(projectId, key, size, 'application/json', tokenId, now, generation),
    blobRegistered.bind(projectId, key, generation, size),
    proof.bind(projectId, key, generation, sourceKind, sourceId, eventId, envelopeHash, sessionId, size, now),
    consumeAuthority.bind(generation),
    clearSettledIntent.bind(physical));
}

/** Records a durable proof for bytes already registered under `generation`, still registered that way when it commits. */
export async function recordProofOfRegistered(db: RelationalStore, guards: readonly BatchGuard[], authority: DerivedAuthority, generation: string | null, now: number): Promise<void> {
  const { projectId, key, size, sourceKind, sourceId, eventId, envelopeHash, sessionId } = authority;
  await commitAfter(db, guards,
    blobRegistered.bind(projectId, key, generation, size),
    proof.bind(projectId, key, generation, sourceKind, sourceId, eventId, envelopeHash, sessionId, size, now));
}

