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
import { accountMemberRow, dashboardMemberRow, hasLinkedAdmin, linkMintWrite, linkPreviewRead, linkReplaceUnspentWrite, memberLinkRowOf, redeemIdentityLink } from '../db/identity/link.js';
import { commitNamed, first, type Bound } from '../db/index.js';
import { toBase64Url } from '../base64.js';
import type { RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import { emit } from '../telemetry.js';
import { asMemberRole, type MemberRole } from './roles.js';

/** Bytes of entropy in a link key. 32 = 256 bits. */
const IDENTITY_LINK_KEY_BYTES = 32;
/** Lifetime of a freshly minted authority: the member is at the keyboard, and a first sign-in with a second factor fits inside it. */
export { IDENTITY_LINK_TTL_MS } from '@goondocks/myco-shared/member-protocol';
/** Lifetime of an authority an admin creates for another member: it is handed over, like an invitation, so it lives as long as one does by default. */
export const ADMIN_IDENTITY_LINK_TTL_MS = 60 * 60 * 1000;
const IDENTITY_LINK_ID_PREFIX = 'il_';
const IDENTITY_LINK_ID_BYTES = 12;
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
export { hasLinkedAdmin };

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
  const issue = await identityLinkWrites(memberId, nowMs, options);
  const { insert } = await commitNamed(db, { insert: issue.insert, replace: issue.replace });
  return insert.results.length === 1 ? { key: issue.key, id: issue.id, expiresAt: issue.expiresAt } : null;
}

/**
 * The writes that mint one key: the insert, gated by the rule above, first, and with `replaceUnspent` the revocation of
 * the member's other unspent keys, which applies only once that insert landed. Each holds on its own, so they are
 * safe run in order where no batch runs them together; the insert's returned row says whether it minted a key.
 */
export async function identityLinkWrites(
  memberId: string, nowMs: number, options: { ttlMs?: number; replaceUnspent?: boolean; issuedBy?: string } = {},
): Promise<{ insert: Bound<{ id: string }, 'write'>; replace: Bound<never, 'write'>[]; key: string; id: string; expiresAt: number }> {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_KEY_BYTES)));
  const id = `${IDENTITY_LINK_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(IDENTITY_LINK_ID_BYTES)))}`;
  const expiresAt = nowMs + (options.ttlMs ?? IDENTITY_LINK_TTL_MS);
  const insert = linkMintWrite({ id, hash: await sha256Hex(key), memberId, now: nowMs, expiresAt, issuedBy: options.issuedBy ?? null });
  return { insert, replace: options.replaceUnspent ? [linkReplaceUnspentWrite(nowMs, memberId, id)] : [], key, id, expiresAt };
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
 * Spends a key for the signed-in account, once: decision, spend, bind and initial ownership commit together, including
 * terminal refusals, and a retry by the same account answers what that commit decided.
 */
export async function spendIdentityLinkAuthority(
  db: RelationalStore, presentedKey: string, githubId: string, nowMs: number,
): Promise<IdentityLinkResult> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey) || !GITHUB_ACCOUNT_ID.test(githubId)) return { ok: false, reason: 'denied' };
  const redeemed = await redeemIdentityLink(db, await sha256Hex(presentedKey), githubId, nowMs);
  if (redeemed.ok && !redeemed.replayed) emit({ kind: 'identity_linked', memberId: redeemed.member.id, sub: githubId });
  return redeemed.ok ? { ok: true, member: redeemed.member } : { ok: false, reason: redeemed.reason };
}

/** Whether a member can be given a link now: absent, removed, already linked, or open to one. */
type MemberLinkState = 'absent' | 'revoked' | 'linked' | 'unlinked';

export async function memberLinkState(db: RelationalStore, memberId: string): Promise<MemberLinkState> {
  const row = await memberLinkRowOf(db, memberId);
  if (row === null) return 'absent';
  if (row.revoked_at !== null) return 'revoked';
  return row.github_id === null ? 'unlinked' : 'linked';
}

type IdentityLinkPreview =
  | { ok: true; member: DashboardMember }
  | { ok: false; reason: Extract<IdentityLinkRefusal, 'denied' | 'link_requires_admin'> };

/** The member a live key names, for the page that asks the account holder to confirm, or why the key would bind nothing. Spends nothing. */
export async function previewIdentityLinkAuthority(db: RelationalStore, presentedKey: string, nowMs: number): Promise<IdentityLinkPreview> {
  if (!IDENTITY_LINK_KEY_PATTERN.test(presentedKey)) return { ok: false, reason: 'denied' };
  const row = await first(db, linkPreviewRead(await sha256Hex(presentedKey), nowMs));
  if (row === null || row.revoked_at !== null) return { ok: false, reason: 'denied' };
  const role = asMemberRole(row.role);
  if (role === null) return { ok: false, reason: 'denied' };
  if (Number(row.admitted) !== 1) return { ok: false, reason: 'link_requires_admin' };
  return { ok: true, member: { id: row.id, label: row.label, role } };
}

/** The signed-in account's own membership state, including inactive access. */
export async function accountMembership(db: RelationalStore, githubId: string) {
  const row = await accountMemberRow(db, githubId);
  const state = row === null ? await hasLinkedAdmin(db) ? 'unlinked' as const : 'unclaimed' as const : row.revoked_at === null ? 'active' as const : 'inactive' as const;
  return { state, reason: state === 'inactive' ? 'Your access to this server is inactive. Ask an administrator to restore your access.' : null };
}

/** The unrevoked member this GitHub account is linked to, or null. Read on every dashboard request. */
export async function memberByGithubId(db: RelationalStore, githubId: string): Promise<DashboardMember | null> {
  if (!GITHUB_ACCOUNT_ID.test(githubId)) return null;
  const row = await dashboardMemberRow(db, githubId);
  if (row === null) return null;
  const role = asMemberRole(row.role);
  // A role outside the grammar admits nobody: an unreadable role must not decide admission by accident.
  return role === null ? null : { id: row.id, label: row.label, role };
}
