/**
 * Identity link authorities — the proof that binds a GitHub account to a member.
 *
 * A member credential mints one; the account that signs in through GitHub
 * spends it, and that account becomes the member's dashboard identity. The
 * joiner never names a member: the authority carries the member it names at mint
 * for, so a stolen key can only bind the thief's own account to that member,
 * within the key's window, once. It is the enrollment authority's shape a third
 * time — 256 bits, hashed at rest, spent by one conditional update, expiring.
 *
 * A member's account is fixed once linked. Changing it is break-glass: direct
 * store access, the same authority #907 settled as the recovery path.
 */
import { toBase64Url } from '../base64.js';
import type { RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import { emit } from '../telemetry.js';
import { MEMBER_REVOKED_BY, memberRevokedByParams } from '../db/liveness.js';

/** Bytes of entropy in a link key. 32 = 256 bits. */
export const IDENTITY_LINK_KEY_BYTES = 32;
/** Lifetime of a freshly minted authority: the member is at the keyboard, and a first sign-in with a second factor fits inside it. */
export const IDENTITY_LINK_TTL_MS = 15 * 60 * 1000;
export const IDENTITY_LINK_ID_PREFIX = 'il_';
const IDENTITY_LINK_ID_BYTES = 12;
/** How long a finished authority stays before the spend path reclaims it. */
export const IDENTITY_LINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The grammar of a presented key: exactly the base64url of `IDENTITY_LINK_KEY_BYTES`. */
export const IDENTITY_LINK_KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((IDENTITY_LINK_KEY_BYTES * 4) / 3)}}$`);

/** A GitHub account id: digits only. */
export const GITHUB_ACCOUNT_ID = /^[0-9]+$/;

export interface IssuedIdentityLinkAuthority {
  key: string;
  id: string;
  expiresAt: number;
}

/** A member as the dashboard sees it. */
export interface DashboardMember {
  id: string;
  label: string | null;
}

/** Sole minter. Stores the digest against the member; returns the raw key once. */
export async function issueIdentityLinkAuthority(
  db: RelationalStore, memberId: string, nowMs: number, options: { ttlMs?: number } = {},
): Promise<IssuedIdentityLinkAuthority> {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_KEY_BYTES)));
  const id = `${IDENTITY_LINK_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_ID_BYTES)))}`;
  const expiresAt = nowMs + (options.ttlMs ?? IDENTITY_LINK_TTL_MS);
  await db
    .prepare(`INSERT INTO identity_link_authorities (id, key_hash, member_id, created_at, expires_at, used_at, used_by, revoked_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`)
    .bind(id, await sha256Hex(key), memberId, nowMs, expiresAt)
    .run();
  return { key, id, expiresAt };
}

/**
 * Why a presented key did not bind.
 *
 * `denied` covers unknown, spent, expired and revoked alike: the holder learns
 * only that this key binds nothing. `identity_taken`: the signed-in account is
 * already another member's. `member_linked`: the member the key names already
 * has an account — what the victim of a stolen key sees. `member_revoked`: the
 * member the key names is gone.
 */
export type IdentityLinkRefusal = 'denied' | 'identity_taken' | 'member_linked' | 'member_revoked';

export type IdentityLinkResult =
  | { ok: true; member: DashboardMember }
  | { ok: false; reason: IdentityLinkRefusal };

/**
 * Spends a presented key for the signed-in account, once, and binds that account
 * to the member the key names.
 *
 * The spend is one conditional update, decided by its changed-row count, so two
 * spends of one key produce one winner. The account and the member are read
 * before the bind so each refusal is named rather than surfacing as a constraint
 * failure; the bind itself is one conditional update with a changed-row check,
 * so a member revoked or linked between the reads and the write is still refused.
 */
export async function spendIdentityLinkAuthority(
  db: RelationalStore, presentedKey: string, githubId: string, nowMs: number,
): Promise<IdentityLinkResult> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey) || !GITHUB_ACCOUNT_ID.test(githubId)) return { ok: false, reason: 'denied' };
  await reclaimIdentityLinkAuthorities(db, nowMs);
  const keyHash = await sha256Hex(presentedKey);

  const spend = await db
    .prepare(`UPDATE identity_link_authorities SET used_at = ?, used_by = ?
               WHERE key_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .bind(nowMs, githubId, keyHash, nowMs)
    .run();
  if (spend.meta.changes !== 1) return { ok: false, reason: 'denied' };

  const authority = await db
    .prepare(`SELECT member_id FROM identity_link_authorities WHERE key_hash = ?`)
    .bind(keyHash)
    .first<{ member_id: string }>();
  const memberId = authority!.member_id;

  const holder = await db
    .prepare(`SELECT id FROM members WHERE github_id = ?`)
    .bind(githubId)
    .first<{ id: string }>();
  if (holder !== null && holder.id !== memberId) return { ok: false, reason: 'identity_taken' };

  const member = await db
    .prepare(`SELECT id, label, github_id, revoked_at FROM members WHERE id = ?`)
    .bind(memberId)
    .first<{ id: string; label: string | null; github_id: string | null; revoked_at: number | null }>();
  if (member === null || member.revoked_at !== null) return { ok: false, reason: 'member_revoked' };
  if (member.github_id !== null && member.github_id !== githubId) return { ok: false, reason: 'member_linked' };

  let changes: number;
  try {
    const bind = await db
      .prepare(`UPDATE members SET github_id = ? WHERE id = ? AND revoked_at IS NULL AND (github_id IS NULL OR github_id = ?)`)
      .bind(githubId, memberId, githubId)
      .run();
    changes = bind.meta.changes;
  } catch (err) {
    // A bind racing another for the same account meets the unique index; the account is then another member's.
    if (/UNIQUE constraint failed: members\.github_id/.test(err instanceof Error ? err.message : String(err))) return { ok: false, reason: 'identity_taken' };
    throw err;
  }
  if (changes !== 1) return { ok: false, reason: 'member_linked' };

  emit({ kind: 'identity_linked', memberId, sub: githubId });
  return { ok: true, member: { id: member.id, label: member.label } };
}

/** The member a live key names, for the page that asks the account holder to confirm. Spends nothing. */
export async function previewIdentityLinkAuthority(db: RelationalStore, presentedKey: string, nowMs: number): Promise<DashboardMember | null> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey)) return null;
  const row = await db
    .prepare(`SELECT m.id, m.label, m.revoked_at FROM identity_link_authorities a JOIN members m ON m.id = a.member_id
               WHERE a.key_hash = ? AND a.used_at IS NULL AND a.revoked_at IS NULL AND a.expires_at > ?`)
    .bind(await sha256Hex(presentedKey), nowMs)
    .first<{ id: string; label: string | null; revoked_at: number | null }>();
  if (row === null || row.revoked_at !== null) return null;
  return { id: row.id, label: row.label };
}

/** The unrevoked member this GitHub account is linked to, or null. Read on every dashboard request. */
export async function memberByGithubId(db: RelationalStore, githubId: string): Promise<DashboardMember | null> {
  if (!GITHUB_ACCOUNT_ID.test(githubId)) return null;
  const row = await db
    .prepare(`SELECT id, label FROM members WHERE github_id = ? AND revoked_at IS NULL`)
    .bind(githubId)
    .first<{ id: string; label: string | null }>();
  return row === null ? null : { id: row.id, label: row.label };
}

/**
 * Reclaims authorities that are finished — spent, revoked, or expired — and older
 * than `IDENTITY_LINK_RETENTION_MS`. Runs on the spend path, the idiom the
 * enrollment reclaim uses; a live authority is never touched whatever its age.
 */
export async function reclaimIdentityLinkAuthorities(db: RelationalStore, nowMs: number): Promise<{ reclaimed: number }> {
  const cutoff = nowMs - IDENTITY_LINK_RETENTION_MS;
  const result = await db
    .prepare(`DELETE FROM identity_link_authorities
               WHERE (used_at IS NOT NULL AND used_at <= ?)
                  OR (revoked_at IS NOT NULL AND revoked_at <= ?)
                  OR (used_at IS NULL AND revoked_at IS NULL AND expires_at <= ?)`)
    .bind(cutoff, cutoff, cutoff)
    .run();
  return { reclaimed: result.meta.changes };
}

/** Every unspent link key of a member, revoked and attributed — effective only once the member row carries this revocation. */
export function revokeLinkKeysOfMember(db: RelationalStore, memberId: string, revokedBy: string, nowMs: number) {
  return db
    .prepare(`UPDATE identity_link_authorities SET revoked_at = ?, revoked_by = ?
               WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL AND ${MEMBER_REVOKED_BY}`)
    .bind(nowMs, revokedBy, memberId, ...memberRevokedByParams(memberId, nowMs, revokedBy));
}

/** The break-glass bind: the statement an operator applies with their own store access. Clears any earlier account. */
export function linkStatement(db: RelationalStore, memberId: string, githubId: string) {
  return db.prepare(`UPDATE members SET github_id = ? WHERE id = ?`).bind(githubId, memberId);
}
