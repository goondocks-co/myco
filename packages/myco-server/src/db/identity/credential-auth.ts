import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';

export interface AuthRow {
  schema_version: string;
  id: string | null;
  member_id: string | null;
  machine_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  lineage_root: string | null;
  lineage_started_at: number | null;
  predecessor_id: string | null;
  first_used_at: number | null;
  runtime_label: string | null;
  runtime_kind: string | null;
  rotates: number | null;
  /** The credential's member, present only while that member is live. */
  member_live: string | null;
}

export interface ReplayRow { id: string; member_id: string; lineage_root: string; machine_id: string | null; issued_at: number; successor_id: string; first_used_at: number }

const authentication = read<[digest: string], AuthRow>({ name: 'credentialAuth.authenticate', sql:
  `SELECT s.value AS schema_version,
                     t.id, t.member_id, t.machine_id, t.expires_at, t.revoked_at,
                     t.lineage_root, t.lineage_started_at, t.predecessor_id, t.first_used_at,
                     t.runtime_label, t.runtime_kind, t.rotates, m.id AS member_live
                FROM schema_meta s
                LEFT JOIN member_credentials t ON t.token_hash = ?1
                LEFT JOIN members m ON m.id = t.member_id AND m.revoked_at IS NULL
               WHERE s.key = 'version'` });
const replay = read<[digest: string], ReplayRow>({ name: 'credentialAuth.replay', sql:
  `SELECT p.id, p.member_id, p.lineage_root, p.machine_id, p.issued_at, s.id AS successor_id, s.first_used_at
                FROM member_credentials p
                JOIN member_credentials s ON s.lineage_root = p.lineage_root AND s.id <> p.id AND s.first_used_at IS NOT NULL
                 AND (s.predecessor_id = p.id OR (p.first_used_at IS NULL AND s.predecessor_id = p.predecessor_id))
               WHERE p.token_hash = ?1 AND p.revoked_at IS NOT NULL
               ORDER BY s.first_used_at DESC` });
const revokedBy = read<[digest: string, revoker: string], { hit: number }>({ name: 'credentialAuth.revokedBy', sql:
  'SELECT 1 AS hit FROM member_credentials WHERE token_hash = ?1 AND revoked_by = ?2' });
const released = read<[digest: string, harness: string, now: number], { memberId: string; tokenId: string }>({ name: 'credentialAuth.releasedRun', sql:
  `SELECT t.member_id AS memberId, t.id AS tokenId FROM member_credentials t
    JOIN members m ON m.id = t.member_id AND m.revoked_at IS NULL
    WHERE t.token_hash = ?1 AND t.member_id = ?2 AND t.revoked_by = ?2 AND t.revoked_at IS NOT NULL AND t.expires_at > ?3` });
const issued = read<[token: string], { issued_at: number }>({ name: 'credential.issuedAt', sql: 'SELECT issued_at FROM member_credentials WHERE id=?1' });
const revokeById = write<[now: number, actor: string, token: string]>({ name: 'credentialAuth.revokeById', sql:
  'UPDATE member_credentials SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3 AND revoked_at IS NULL' });

/** The schema version joined to the credential a digest names and to its member while live; null when the store holds no version row. */
export async function authenticationRow(db: RelationalStore, digest: string): Promise<AuthRow | null> {
  const [[row]] = await readSet(db, authentication.bind(digest));
  return row ?? null;
}

/** The newest successor that took over from the revoked credential a digest names, or null. */
export async function replayedCredentialRow(db: RelationalStore, digest: string): Promise<ReplayRow | null> {
  const [[row]] = await readSet(db, replay.bind(digest));
  return row ?? null;
}

/** True when the credential a digest names was ended by `revoker`. */
export async function credentialRevokedBy(db: RelationalStore, digest: string, revoker: string): Promise<boolean> {
  const [rows] = await readSet(db, revokedBy.bind(digest, revoker));
  return rows.length > 0;
}

/** The retired run credential a digest names while it is within its original expiry, or null. */
export async function releasedHarnessCredential(db: RelationalStore, digest: string, harness: string, now: number): Promise<{ memberId: string; tokenId: string } | null> {
  const [[row]] = await readSet(db, released.bind(digest, harness, now));
  return row ?? null;
}

/** The instant a credential was issued, or null when no credential has this id. */
export async function credentialIssuedAt(db: RelationalStore, token: string): Promise<number | null> {
  const [[row]] = await readSet(db, issued.bind(token));
  return row?.issued_at ?? null;
}

/** Ends one live credential row with attribution. */
export const credentialRevokeWrite = (request: { token: string; actor: string; now: number }): Bound => revokeById.bind(request.now, request.actor, request.token);
