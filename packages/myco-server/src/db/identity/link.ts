import type { IdentityLinkResult, IdentityLinkRefusal } from '../../auth/identity-link.js';
import { asMemberRole, type MemberRole } from '../../auth/roles.js';
import type { RelationalStore } from '../../core/adapters.js';
import { StorageContractError } from '../../telemetry.js';
import { assertion, commitNamed, first, read, refused, refusalCode, write, type Bound } from '../index.js';
import { notDueForReclaim } from './authority-retention.js';
import { linkAdmitted, linkedAdmin } from './link-policy.js';
import { linkedHumanAdminSql } from './ownership-policy.js';

const IDENTITY_LINK_DENIED = refusalCode('identity_link_denied');
const UNSPENT = (row: string, now: string) => `${row}.used_at IS NULL AND ${row}.revoked_at IS NULL AND ${row}.expires_at>${now} AND ${notDueForReclaim(row, now)}`;

const live = assertion<[hash: string, now: number]>({
  name: 'identity.linkLive', refusal: IDENTITY_LINK_DENIED,
  when: `EXISTS (SELECT 1 FROM identity_link_authorities a WHERE a.key_hash=?1 AND ${UNSPENT('a', '?2')})`,
});
const REFUSAL = `CASE
  WHEN EXISTS (SELECT 1 FROM members holder WHERE holder.github_id=?2 AND holder.id<>a.member_id) THEN 'identity_taken'
  WHEN m.id IS NULL OR m.revoked_at IS NOT NULL OR m.role NOT IN ('admin','member') THEN 'member_revoked'
  WHEN m.github_id IS NOT NULL AND m.github_id<>?2 THEN 'member_linked'
  WHEN NOT (${linkAdmitted('a.issued_by', 'a.member_id')}) THEN 'link_requires_admin'
  ELSE NULL END`;
/** One decision for the whole redemption, recorded first: every later statement acts on this row. */
const decide = write<[hash: string, github: string, now: number], { outcome: 'bound' | IdentityLinkRefusal }>({
  name: 'identity.linkDecide',
  sql: `INSERT INTO identity_link_redemptions(key_hash,github_id,outcome,member_id,decided_at)
    SELECT ?1,?2,COALESCE(${REFUSAL},'bound'),a.member_id,?3 FROM identity_link_authorities a LEFT JOIN members m ON m.id=a.member_id
    WHERE a.key_hash=?1 RETURNING outcome`,
});
const spend = write<[hash: string, github: string, now: number], { member_id: string }>({
  name: 'identity.linkSpend',
  sql: 'UPDATE identity_link_authorities SET used_at=?3,used_by=?2 WHERE key_hash=?1 AND used_at IS NULL AND revoked_at IS NULL RETURNING member_id',
});
const BOUND_MEMBER = "(SELECT member_id FROM identity_link_redemptions WHERE key_hash=?1 AND outcome='bound')";
const bind = write<[hash: string, github: string], { id: string; label: string | null; role: MemberRole }>({
  name: 'identity.linkBind', sql: `UPDATE members SET github_id=?2 WHERE id=${BOUND_MEMBER} RETURNING id,label,role`,
});
/** Fresh ownership follows a bind of a live linked admin, the audit first so it reads the state the owner write replaces. */
const FRESH_OWNER = `FROM deployment_ownership o JOIN members m ON m.id=${BOUND_MEMBER}
  WHERE o.id=1 AND o.member_id IS NULL AND o.bootstrap_mode='fresh' AND m.github_id=?2 AND ${linkedHumanAdminSql('m')}`;
const ownerAudit = write<[hash: string, github: string, now: number]>({
  name: 'identity.linkOwnerAudit',
  sql: `INSERT INTO deployment_ownership_audit(revision,member_id,actor_id,created_at) SELECT o.revision+1,m.id,m.id,?3 ${FRESH_OWNER}`,
});
const owner = write<[hash: string, github: string]>({
  name: 'identity.linkOwner',
  sql: `UPDATE deployment_ownership SET member_id=${BOUND_MEMBER},revision=revision+1,bootstrap_mode='selection'
    WHERE id=1 AND EXISTS (SELECT 1 ${FRESH_OWNER})`,
});

const redemption = read<[hash: string, github: string], { outcome: 'bound' | IdentityLinkRefusal; id: string | null; label: string | null; role: string | null }>({
  name: 'identity.linkRedemption',
  sql: `SELECT r.outcome,m.id,m.label,m.role FROM identity_link_redemptions r
    LEFT JOIN members m ON m.id=r.member_id AND m.github_id=r.github_id AND m.revoked_at IS NULL
    WHERE r.key_hash=?1 AND r.github_id=?2`,
});

export type IdentityLinkRedemption = IdentityLinkResult & { replayed: boolean };

/**
 * A retry of a redemption this same account committed answers what that commit decided, read through the digest and
 * the account together, so another account learns nothing. A bind answers only while the member still holds the
 * account; a key spent before receipts existed, or by anyone else, stays denied.
 */
async function readRedemption(db: RelationalStore, hash: string, github: string): Promise<IdentityLinkRedemption> {
  const row = await first(db, redemption.bind(hash, github));
  if (row === null) return { ok: false, reason: 'denied', replayed: false };
  if (row.outcome !== 'bound') return { ok: false, reason: row.outcome, replayed: true };
  const role = asMemberRole(row.role);
  if (row.id === null || role === null) return { ok: false, reason: 'denied', replayed: false };
  return { ok: true, member: { id: row.id, label: row.label, role }, replayed: true };
}

/** Decide, spend, bind and first ownership in one commit: a key redeems exactly once and its outcome can be read back. */
export async function redeemIdentityLink(db: RelationalStore, hash: string, github: string, now: number): Promise<IdentityLinkRedemption> {
  let committed;
  try {
    committed = await commitNamed(db, {
      live: live.bind(hash, now),
      decided: decide.bind(hash, github, now),
      spent: spend.bind(hash, github, now),
      bound: bind.bind(hash, github),
      ownerAudit: ownerAudit.bind(hash, github, now),
      owner: owner.bind(hash, github),
    });
  } catch (error) {
    if (refused(error, IDENTITY_LINK_DENIED)) return readRedemption(db, hash, github);
    throw error;
  }
  const outcome = committed.decided.results[0]?.outcome;
  if (outcome === undefined || committed.spent.results.length !== 1) throw new StorageContractError('Identity link outcome is missing');
  if (outcome !== 'bound') return { ok: false, reason: outcome, replayed: false };
  const member = committed.bound.results[0];
  if (member === undefined) throw new StorageContractError('Identity link binding is missing');
  return { ok: true, member, replayed: false };
}

const mint = write<[id: string, hash: string, member: string, now: number, expires: number, issuer: string | null], { id: string }>({
  name: 'identity.linkMint',
  sql: `INSERT INTO identity_link_authorities(id,key_hash,member_id,created_at,expires_at,used_at,used_by,revoked_at,issued_by)
    SELECT ?1,?2,?3,?4,?5,NULL,NULL,NULL,?6 WHERE ${linkAdmitted('?6', '?3')} RETURNING id`,
});
const replaceUnspent = write<[now: number, member: string, id: string]>({
  name: 'identity.linkReplaceUnspent',
  sql: `UPDATE identity_link_authorities SET revoked_at=?1 WHERE member_id=?2 AND id<>?3 AND used_at IS NULL AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM identity_link_authorities WHERE id=?3)`,
});
export const linkMintWrite = (fields: { id: string; hash: string; memberId: string; now: number; expiresAt: number; issuedBy: string | null }): Bound<{ id: string }, 'write'> =>
  mint.bind(fields.id, fields.hash, fields.memberId, fields.now, fields.expiresAt, fields.issuedBy);
export const linkReplaceUnspentWrite = (now: number, memberId: string, id: string): Bound<never, 'write'> => replaceUnspent.bind(now, memberId, id);

const preview = read<[hash: string, now: number], { id: string; label: string | null; revoked_at: number | null; role: string; admitted: number }>({
  name: 'identity.linkPreview',
  sql: `SELECT m.id,m.label,m.revoked_at,m.role,${linkAdmitted('a.issued_by', 'a.member_id')} AS admitted
    FROM identity_link_authorities a JOIN members m ON m.id=a.member_id WHERE a.key_hash=?1 AND ${UNSPENT('a', '?2')}`,
});
export const linkPreviewRead = (hash: string, now: number): Bound<{ id: string; label: string | null; revoked_at: number | null; role: string; admitted: number }, 'read'> => preview.bind(hash, now);

const linkedAdminPresent = read<[], { one: number }>({ name: 'identity.linkedAdminPresent', sql: `SELECT 1 AS one FROM members la WHERE ${linkedAdmin('la')} LIMIT 1` });
export const hasLinkedAdmin = async (db: RelationalStore): Promise<boolean> => await first(db, linkedAdminPresent.bind()) !== null;

const accountRow = read<[github: string], { revoked_at: number | null }>({ name: 'identity.accountRow', sql: 'SELECT revoked_at FROM members WHERE github_id=?1' });
export const accountMemberRow = (db: RelationalStore, github: string): Promise<{ revoked_at: number | null } | null> => first(db, accountRow.bind(github));

const dashboardRow = read<[github: string], { id: string; label: string | null; role: string }>({
  name: 'identity.dashboardMember', sql: 'SELECT id,label,role FROM members WHERE github_id=?1 AND revoked_at IS NULL',
});
export const dashboardMemberRow = (db: RelationalStore, github: string): Promise<{ id: string; label: string | null; role: string } | null> => first(db, dashboardRow.bind(github));

const memberLinkRow = read<[member: string], { github_id: string | null; revoked_at: number | null }>({
  name: 'identity.memberLinkState', sql: 'SELECT github_id,revoked_at FROM members WHERE id=?1',
});
export const memberLinkRowOf = (db: RelationalStore, memberId: string): Promise<{ github_id: string | null; revoked_at: number | null } | null> => first(db, memberLinkRow.bind(memberId));
