import { IDENTITY_LINK_TTL_MS } from '@goondocks/myco-shared/member-protocol';
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
 * self-hosted first-owner setup) mints one only for an admin, and only while the
 * Deployment has no live admin with a GitHub account linked, so the first
 * sign-in on a fresh Deployment is the only one a member credential can choose; after that, only an
 * admin signed in to the dashboard mints one, for a member they name. The same
 * rule is composed into the mint and into the bind, so a key minted during
 * bootstrap binds nothing once bootstrap is over, and a key an admin minted binds
 * nothing once that admin is revoked, unlinked or no longer an admin.
 *
 * A member's account is fixed once linked. Changing it is break-glass: direct
 * store access, the same authority #907 settled as the recovery path.
 */
import { spendIdentityLink } from '../db/identity/link.js';
import { toBase64Url } from '../base64.js';
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import { emit } from '../telemetry.js';
import { MEMBER_REVOKED_BY, memberRevokedByParams } from '../db/liveness.js';
import { asMemberRole, type MemberRole } from './roles.js';

/** Bytes of entropy in a link key. 32 = 256 bits. */
export const IDENTITY_LINK_KEY_BYTES = 32;
/** Lifetime of a freshly minted authority: the member is at the keyboard, and a first sign-in with a second factor fits inside it. */
export { IDENTITY_LINK_TTL_MS } from '@goondocks/myco-shared/member-protocol';
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

export { linkedAdmin } from '../db/identity/link-policy.js';
import { linkedAdmin, linkAdmitted } from '../db/identity/link-policy.js';
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
  const issue = await identityLinkStatements(db, memberId, nowMs, options);
  const [written] = await db.batch(issue.statements);
  return written?.meta.changes === 1 ? { key: issue.key, id: issue.id, expiresAt: issue.expiresAt } : null;
}

/**
 * The statements that mint one key, and the key they mint: the insert, gated by the rule above, first, and with
 * `replaceUnspent` the revocation of the member's other unspent keys, which applies only once that insert landed. Each
 * holds on its own, so they are safe run in order where no batch runs them together; the insert's changed-row count
 * says whether it minted a key.
 */
export async function identityLinkStatements(
  db: RelationalStore, memberId: string, nowMs: number, options: { ttlMs?: number; replaceUnspent?: boolean; issuedBy?: string } = {},
): Promise<{ statements: PreparedStatement[]; key: string; id: string; expiresAt: number }> {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_KEY_BYTES)));
  const id = `${IDENTITY_LINK_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_ID_BYTES)))}`;
  const expiresAt = nowMs + (options.ttlMs ?? IDENTITY_LINK_TTL_MS);
  const issuedBy = options.issuedBy ?? null;
  const insert = db
    .prepare(`INSERT INTO identity_link_authorities (id, key_hash, member_id, created_at, expires_at, used_at, used_by, revoked_at, issued_by)
              SELECT ?, ?, ?, ?, ?, NULL, NULL, NULL, ? WHERE ${linkAdmitted('?', '?')}`)
    .bind(id, await sha256Hex(key), memberId, nowMs, expiresAt, issuedBy, memberId, issuedBy, memberId, issuedBy);
  const replace = options.replaceUnspent
    ? [db.prepare(`UPDATE identity_link_authorities SET revoked_at = ?
                    WHERE member_id = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL
                      AND EXISTS (SELECT 1 FROM identity_link_authorities WHERE id = ?)`).bind(nowMs, memberId, id, id)]
    : [];
  return { statements: [insert, ...replace], key, id, expiresAt };
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

/** Spend, bind and initial ownership commit together, including terminal refusals. */
export async function spendIdentityLinkAuthority(
  db: RelationalStore, presentedKey: string, githubId: string, nowMs: number,
): Promise<IdentityLinkResult> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey) || !GITHUB_ACCOUNT_ID.test(githubId)) return { ok: false, reason: 'denied' };
  await reclaimIdentityLinkAuthorities(db, nowMs);
  const result = await spendIdentityLink(db, await sha256Hex(presentedKey), githubId, nowMs);
  if (result.ok) emit({ kind: 'identity_linked', memberId: result.member.id, sub: githubId });
  return result;
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

export type IdentityLinkPreview =
  | { ok: true; member: DashboardMember }
  | { ok: false; reason: Extract<IdentityLinkRefusal, 'denied' | 'link_requires_admin'> };

/** The member a live key names, for the page that asks the account holder to confirm, or why the key would bind nothing. Spends nothing. */
export async function previewIdentityLinkAuthority(db: RelationalStore, presentedKey: string, nowMs: number): Promise<IdentityLinkPreview> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey)) return { ok: false, reason: 'denied' };
  const row = await db
    .prepare(`SELECT m.id, m.label, m.revoked_at, m.role, ${linkAdmitted('a.issued_by', 'a.member_id')} AS admitted
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

/** Whether anyone can sign in as a live administrator. */
export async function hasLinkedAdmin(db: RelationalStore): Promise<boolean> {
  return await db.prepare(`SELECT 1 AS one FROM members la WHERE ${linkedAdmin('la')} LIMIT 1`).first() !== null;
}

/** The signed-in account's own membership state, including inactive access. */
export async function accountMembership(db: RelationalStore, githubId: string) {
  const row = await db.prepare('SELECT revoked_at FROM members WHERE github_id = ?').bind(githubId).first<{ revoked_at: number | null }>();
  const state = row === null ? await hasLinkedAdmin(db) ? 'unlinked' as const : 'unclaimed' as const : row.revoked_at === null ? 'active' as const : 'inactive' as const;
  return { state, reason: state === 'inactive' ? 'Your access to this server is inactive. Ask an administrator to restore your access.' : null };
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
