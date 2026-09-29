/**
 * Identity link authorities — the proof that binds a GitHub account to a member.
 *
 * The account that signs in through GitHub spends one, and that account becomes
 * the member's dashboard identity. The joiner never names a member: the
 * authority carries the member it names at mint for, so a stolen key can only
 * bind the thief's own account to that member, within the key's window, once. It
 * is the enrollment authority's shape a third time — 256 bits, hashed at rest,
 * spent by one conditional update, expiring.
 *
 * Who may mint one is bootstrap, then admin. A member's own credential (and a
 * self-hosted first-owner setup) mints one only while the Deployment has no live
 * admin with a GitHub account linked, so the first sign-in on a fresh
 * Deployment is the only one a member credential can choose; after that, only an
 * admin signed in to the dashboard mints one, for a member they name. The same
 * rule is composed into the mint and into the bind, so a key minted during
 * bootstrap binds nothing once bootstrap is over, and a key an admin minted binds
 * nothing once that admin is revoked, unlinked or no longer an admin.
 *
 * A member's account is fixed once linked. Changing it is break-glass: direct
 * store access, the same authority #907 settled as the recovery path.
 */
import { toBase64Url } from '../base64.js';
import type { RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import { emit } from '../telemetry.js';
import { MEMBER_REVOKED_BY, memberRevokedByParams } from '../db/liveness.js';
import { asMemberRole, type MemberRole } from './roles.js';

const ADMIN: MemberRole = 'admin';

/** Bytes of entropy in a link key. 32 = 256 bits. */
export const IDENTITY_LINK_KEY_BYTES = 32;
/** Lifetime of a freshly minted authority: the member is at the keyboard, and a first sign-in with a second factor fits inside it. */
export const IDENTITY_LINK_TTL_MS = 15 * 60 * 1000;
/** Lifetime of an authority an admin creates for another member: it is handed over, like an invitation, so it lives as long as one does by default. */
export const ADMIN_IDENTITY_LINK_TTL_MS = 60 * 60 * 1000;
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

/** A member as the dashboard sees it, including the role every admin-only surface admits on. */
export interface DashboardMember {
  id: string;
  label: string | null;
  role: MemberRole;
}

/** A live admin with a GitHub account linked, as a predicate on the members row aliased `alias`: someone who can sign in to the dashboard and administer it. */
const linkedAdmin = (alias: string): string =>
  `${alias}.role = '${ADMIN}' AND ${alias}.github_id IS NOT NULL AND ${alias}.revoked_at IS NULL`;

/**
 * Whether a key issued by `issuer` — a SQL expression, NULL for a key a
 * member's own credential minted — may be minted or bind now: a self-issued key
 * while no live admin has a GitHub account linked, an admin-issued key while its
 * issuer is still a live, linked admin. The one statement of the rule; the mint
 * and the bind each compose it into their own write, so no read decides it
 * ahead of the write it guards.
 */
const linkAdmitted = (issuer: string): string =>
  `(((${issuer}) IS NULL AND NOT EXISTS (SELECT 1 FROM members la WHERE ${linkedAdmin('la')}))
    OR EXISTS (SELECT 1 FROM members la WHERE la.id = (${issuer}) AND ${linkedAdmin('la')}))`;

/**
 * Sole minter. Stores the digest against the member; returns the raw key once,
 * or null when the rule above refuses the issuer now, in which case nothing is
 * written. `issuedBy` names the admin creating the key from the dashboard;
 * absent, the key is the member's own. `replaceUnspent` revokes the member's
 * other unspent keys once this one is written.
 */
export async function issueIdentityLinkAuthority(
  db: RelationalStore, memberId: string, nowMs: number, options: { ttlMs?: number; replaceUnspent?: boolean; issuedBy?: string } = {},
): Promise<IssuedIdentityLinkAuthority | null> {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_KEY_BYTES)));
  const id = `${IDENTITY_LINK_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_ID_BYTES)))}`;
  const expiresAt = nowMs + (options.ttlMs ?? IDENTITY_LINK_TTL_MS);
  const issuedBy = options.issuedBy ?? null;
  const insert = db
    .prepare(`INSERT INTO identity_link_authorities (id, key_hash, member_id, created_at, expires_at, used_at, used_by, revoked_at, issued_by)
              SELECT ?, ?, ?, ?, ?, NULL, NULL, NULL, ? WHERE ${linkAdmitted('?')}`)
    .bind(id, await sha256Hex(key), memberId, nowMs, expiresAt, issuedBy, issuedBy, issuedBy);
  const [written] = await db.batch([
    insert,
    ...(options.replaceUnspent
      ? [db.prepare(`UPDATE identity_link_authorities SET revoked_at = ?
                      WHERE member_id = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL
                        AND EXISTS (SELECT 1 FROM identity_link_authorities WHERE id = ?)`).bind(nowMs, memberId, id, id)]
      : []),
  ]);
  return written?.meta.changes === 1 ? { key, id, expiresAt } : null;
}

/**
 * Why a presented key did not bind.
 *
 * `denied` covers unknown, spent, expired and revoked alike: the holder learns
 * only that this key binds nothing. `identity_taken`: the signed-in account is
 * already another member's. `member_linked`: the member the key names already
 * has an account — what the victim of a stolen key sees. `member_revoked`: the
 * member the key names is gone. `link_requires_admin`: the key's issuer may no
 * longer link — a member's own key once the Deployment has a linked admin, or an
 * admin's key once that admin no longer is one.
 */
export type IdentityLinkRefusal = 'denied' | 'identity_taken' | 'member_linked' | 'member_revoked' | 'link_requires_admin';

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
 * failure; the bind itself is one conditional update with a changed-row check
 * that carries the issuer rule, so a member revoked or linked, or an admin
 * linked, between the reads and the write is still refused — of two bootstrap
 * keys spent at once for two admins, the first bind ends bootstrap and the
 * second changes nothing.
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
    .prepare(`SELECT id, label, github_id, revoked_at, role FROM members WHERE id = ?`)
    .bind(memberId)
    .first<{ id: string; label: string | null; github_id: string | null; revoked_at: number | null; role: string }>();
  if (member === null || member.revoked_at !== null) return { ok: false, reason: 'member_revoked' };
  const memberRole = asMemberRole(member.role);
  if (memberRole === null) return { ok: false, reason: 'member_revoked' };
  if (member.github_id !== null && member.github_id !== githubId) return { ok: false, reason: 'member_linked' };

  let changes: number;
  try {
    const bind = await db
      .prepare(`UPDATE members SET github_id = ?
                 WHERE id = ? AND revoked_at IS NULL AND (github_id IS NULL OR github_id = ?)
                   AND EXISTS (SELECT 1 FROM identity_link_authorities a WHERE a.key_hash = ? AND ${linkAdmitted('a.issued_by')})`)
      .bind(githubId, memberId, githubId, keyHash)
      .run();
    changes = bind.meta.changes;
  } catch (err) {
    // A bind racing another for the same account meets the unique index; the account is then another member's.
    if (/UNIQUE constraint failed: members\.github_id/.test(err instanceof Error ? err.message : String(err))) return { ok: false, reason: 'identity_taken' };
    throw err;
  }
  if (changes !== 1) return { ok: false, reason: await unboundReason(db, memberId, githubId) };

  emit({ kind: 'identity_linked', memberId, sub: githubId });
  return { ok: true, member: { id: member.id, label: member.label, role: memberRole } };
}

/** Whether a member can be given a link now: absent, removed, already linked, or open to one. */
export type MemberLinkState = 'absent' | 'revoked' | 'linked' | 'unlinked';

export async function memberLinkState(db: RelationalStore, memberId: string): Promise<MemberLinkState> {
  const row = await db
    .prepare(`SELECT github_id, revoked_at FROM members WHERE id = ?`)
    .bind(memberId)
    .first<{ github_id: string | null; revoked_at: number | null }>();
  if (row === null) return 'absent';
  if (row.revoked_at !== null) return 'revoked';
  return row.github_id === null ? 'unlinked' : 'linked';
}

/** Why a bind that changed no row changed none, read after it: the member is gone, holds another account, or the key's issuer may no longer link. */
async function unboundReason(db: RelationalStore, memberId: string, githubId: string): Promise<IdentityLinkRefusal> {
  const member = await db
    .prepare(`SELECT github_id, revoked_at FROM members WHERE id = ?`)
    .bind(memberId)
    .first<{ github_id: string | null; revoked_at: number | null }>();
  if (member === null || member.revoked_at !== null) return 'member_revoked';
  if (member.github_id !== null && member.github_id !== githubId) return 'member_linked';
  return 'link_requires_admin';
}

export type IdentityLinkPreview =
  | { ok: true; member: DashboardMember }
  | { ok: false; reason: Extract<IdentityLinkRefusal, 'denied' | 'link_requires_admin'> };

/** The member a live key names, for the page that asks the account holder to confirm, or why the key would bind nothing. Spends nothing. */
export async function previewIdentityLinkAuthority(db: RelationalStore, presentedKey: string, nowMs: number): Promise<IdentityLinkPreview> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey)) return { ok: false, reason: 'denied' };
  const row = await db
    .prepare(`SELECT m.id, m.label, m.revoked_at, m.role, ${linkAdmitted('a.issued_by')} AS admitted
                FROM identity_link_authorities a JOIN members m ON m.id = a.member_id
               WHERE a.key_hash = ? AND a.used_at IS NULL AND a.revoked_at IS NULL AND a.expires_at > ?`)
    .bind(await sha256Hex(presentedKey), nowMs)
    .first<{ id: string; label: string | null; revoked_at: number | null; role: string; admitted: number }>();
  if (row === null || row.revoked_at !== null) return { ok: false, reason: 'denied' };
  const role = asMemberRole(row.role);
  if (role === null) return { ok: false, reason: 'denied' };
  if (Number(row.admitted) !== 1) return { ok: false, reason: 'link_requires_admin' };
  return { ok: true, member: { id: row.id, label: row.label, role } };
}

/** The unrevoked member this GitHub account is linked to, or null. Read on every dashboard request. */
export async function memberByGithubId(db: RelationalStore, githubId: string): Promise<DashboardMember | null> {
  if (!GITHUB_ACCOUNT_ID.test(githubId)) return null;
  const row = await db
    .prepare(`SELECT id, label, role FROM members WHERE github_id = ? AND revoked_at IS NULL`)
    .bind(githubId)
    .first<{ id: string; label: string | null; role: string }>();
  if (row === null) return null;
  const role = asMemberRole(row.role);
  // A role outside the grammar admits nobody: an unreadable role must not decide admission by accident.
  return role === null ? null : { id: row.id, label: row.label, role };
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
