/**
 * Enrollment authorities — the invitation that a join exchanges for a member
 * credential. An enrollment authority is never the credential used for ordinary
 * requests: its only accepted use is the join route.
 *
 * The properties are the ones the 1.4 Team Host join keys already proved, moved
 * from a file on one host into the Deployment's store so one implementation
 * serves every target:
 *
 *   - 256 bits of entropy. Nothing rate-limits a guess into existence.
 *   - HASHED AT REST. The raw value exists exactly twice — the mint reveal and
 *     the one join request — so a key read out of the store is not replayable.
 *   - SINGLE USE, spent by an atomic conditional update that reports whether it
 *     changed a row. A read-then-mark-used spend admits two joins on one key
 *     under a race; a vendor whose core business is device enrollment shipped
 *     exactly that bug.
 *   - EXPIRING, so an invitation left in a chat log stops working on its own.
 *   - REVOCABLE before use, and recording which runtime spent it.
 */
import { toBase64Url } from '../base64.js';
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';

/** Bytes of entropy in an enrollment key. 32 = 256 bits. */
export const ENROLLMENT_KEY_BYTES = 32;

/**
 * How long a spent, expired or revoked authority is kept before it is reclaimed.
 *
 * A finished authority is audit material, not a credential: `used_at` and
 * `used_by_runtime` say which runtime spent which invitation, and that is worth
 * having while a join is still recent enough to be questioned. It is not worth
 * keeping forever: the join it authorised is recorded on the credential itself, so
 * nothing downstream resolves through it.
 */
export const ENROLLMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default lifetime of a freshly minted key. An invitation is handed over in the moment; one that outlives the conversation is a standing credential nobody remembers issuing. */
export const ENROLLMENT_TTL_MS = 60 * 60 * 1000;

export const ENROLLMENT_ID_PREFIX = 'en_';
const ENROLLMENT_ID_BYTES = 12;

/** Shape of every minted key: `ENROLLMENT_KEY_BYTES` random bytes as unpadded base64url. */
export const ENROLLMENT_KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((ENROLLMENT_KEY_BYTES * 4) / 3)}}$`);

export interface IssuedEnrollmentAuthority {
  key: string;
  id: string;
  expiresAt: number;
}

/**
 * The insert that stores a fresh key's digest, and the raw key returned once.
 *
 * `memberId` is what the key admits the joiner AS. Null means the join enrolls a
 * new person and the server names the member; a value means the key adds another
 * runtime to a member who already exists — the same human on a second machine or
 * in a sandbox, which the model requires be one identity rather than two.
 * Whichever it is, it is fixed when the key is minted: the joiner never names its
 * own member, so a stolen key cannot be redirected at somebody else's identity.
 */
export function enrollmentInsert(
  db: RelationalStore, nowMs: number, ttlMs: number, createdByMember: string | null, keyHash: string, id: string, memberId: string | null = null,
): { statement: PreparedStatement; expiresAt: number } {
  const expiresAt = nowMs + ttlMs;
  const statement = db
    .prepare(`INSERT INTO enrollment_authorities (id, key_hash, created_at, expires_at, used_at, used_by_runtime, revoked_at, created_by_member, member_id)
              VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
    .bind(id, keyHash, nowMs, expiresAt, createdByMember, memberId);
  return { statement, expiresAt };
}

/** Sole minter of enrollment authorities. Stores the digest; returns the raw key once. */
export async function issueEnrollmentAuthority(
  db: RelationalStore, nowMs: number, options: { ttlMs?: number; createdByMember?: string | null; memberId?: string | null } = {},
): Promise<IssuedEnrollmentAuthority> {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_KEY_BYTES)));
  const id = `${ENROLLMENT_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_ID_BYTES)))}`;
  const { statement, expiresAt } = enrollmentInsert(
    db, nowMs, options.ttlMs ?? ENROLLMENT_TTL_MS, options.createdByMember ?? null, await sha256Hex(key), id, options.memberId ?? null,
  );
  await statement.run();
  return { key, id, expiresAt };
}

/** Why a presented key cannot be spent. */
export type EnrollmentRefusal = 'unknown' | 'already_used' | 'expired' | 'revoked';

export type SpendResult =
  | { ok: true; id: string; memberId: string | null }
  | { ok: false; reason: EnrollmentRefusal };

/**
 * Spends a presented key, once.
 *
 * The spend is a single conditional update guarded on the row still being
 * unused, unrevoked and unexpired, and it reports success only when it changed
 * exactly one row. Two concurrent joins presenting one key therefore produce one
 * winner and one `already_used` — the check and the mark are the same statement,
 * so there is no window between them.
 *
 * A refusal reads the row afterwards only to say WHY, never to decide whether
 * the spend succeeded.
 */
export async function spendEnrollmentAuthority(
  db: RelationalStore, presentedKey: string, nowMs: number, runtime: string,
): Promise<SpendResult> {
  if (!ENROLLMENT_KEY_PATTERN.test(presentedKey)) return { ok: false, reason: 'unknown' };
  const keyHash = await sha256Hex(presentedKey);

  const spend = await db
    .prepare(`UPDATE enrollment_authorities SET used_at = ?, used_by_runtime = ?
               WHERE key_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .bind(nowMs, runtime, keyHash, nowMs)
    .run();

  const row = await db
    .prepare(`SELECT id, used_at, revoked_at, expires_at, member_id FROM enrollment_authorities WHERE key_hash = ?`)
    .bind(keyHash)
    .first<{ id: string; used_at: number | null; revoked_at: number | null; expires_at: number; member_id: string | null }>();

  if (spend.meta.changes === 1) return { ok: true, id: row!.id, memberId: row!.member_id };
  if (row === null) return { ok: false, reason: 'unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.used_at !== null) return { ok: false, reason: 'already_used' };
  return { ok: false, reason: 'expired' };
}

/** Revokes an unused key. `revoked` is false when no unused row matched the id. */
export async function revokeEnrollmentAuthority(
  db: RelationalStore, id: string, nowMs: number,
): Promise<{ revoked: boolean }> {
  const result = await db
    .prepare(`UPDATE enrollment_authorities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL`)
    .bind(nowMs, id)
    .run();
  return { revoked: result.meta.changes === 1 };
}

/**
 * Records a member if the Deployment does not already hold one under `id`. Idempotent:
 * a second call for the same id changes nothing and never disturbs an existing label.
 *
 * Every credential carries a foreign key to `members`, so this is what has to have run
 * before one can be issued. It lives here rather than at each caller so the member row
 * and the credential row are written by the same module — a facade that opens its own
 * INSERT is the shape the read-layer gate refuses.
 */
export async function ensureMember(db: RelationalStore, id: string, nowMs: number, label = id): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO members (id, label, created_at, revoked_at) VALUES (?, ?, ?, NULL)`)
    .bind(id, label, nowMs)
    .run();
}

/**
 * Reclaims authorities that are finished — spent, revoked, or expired — and older
 * than `ENROLLMENT_RETENTION_MS`.
 *
 * This runs on the join path rather than on a schedule, the way expired blob
 * reservations are reclaimed as part of the reservation that replaces them: the
 * table only grows when someone joins, so the moment of growth is the moment to
 * trim it, and a Deployment that never joins again never accumulates anything to
 * collect. `changes` says how many were reclaimed.
 *
 * A LIVE authority is never touched whatever its age — reclaiming an unspent
 * invitation is retention deciding to revoke, which is the operator's call.
 */
export async function reclaimEnrollmentAuthorities(db: RelationalStore, nowMs: number): Promise<{ reclaimed: number }> {
  const cutoff = nowMs - ENROLLMENT_RETENTION_MS;
  const result = await db
    .prepare(`DELETE FROM enrollment_authorities
               WHERE (used_at IS NOT NULL AND used_at <= ?)
                  OR (revoked_at IS NOT NULL AND revoked_at <= ?)
                  OR (used_at IS NULL AND revoked_at IS NULL AND expires_at <= ?)`)
    .bind(cutoff, cutoff, cutoff)
    .run();
  return { reclaimed: result.meta.changes };
}

/**
 * Claims `machineId` for `memberId`, or reports who already holds it.
 *
 * The insert is `OR IGNORE` against a PRIMARY KEY, so the claim is decided by the
 * database rather than by whoever reads first: two joins racing for one identity
 * produce one holder and one refusal. The read afterwards names the holder — it
 * never decides the outcome, only reports it.
 *
 * A member re-claiming an identity it already holds succeeds, which is what lets
 * a machine re-join after its credential is revoked or expires.
 */
export async function claimMachineIdentity(
  db: RelationalStore, machineId: string, memberId: string, nowMs: number,
): Promise<{ claimed: boolean; heldBy: string }> {
  await db
    .prepare(`INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)`)
    .bind(machineId, memberId, nowMs)
    .run();
  const row = await db
    .prepare(`SELECT member_id FROM machine_claims WHERE machine_id = ?`)
    .bind(machineId)
    .first<{ member_id: string }>();
  const heldBy = row!.member_id;
  return { claimed: heldBy === memberId, heldBy };
}
