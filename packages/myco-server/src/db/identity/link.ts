import type { RelationalStore } from '../../core/adapters.js';
import type { IdentityLinkResult, IdentityLinkRefusal } from '../../auth/identity-link.js';
import type { MemberRole } from '../../auth/roles.js';
import { linkedHumanAdminSql } from '../../core/ownership.js';
import { linkAdmitted } from './link-policy.js';
import { assertion, commit, read, refusalCode, refused, write } from '../index.js';

const IDENTITY_LINK_DENIED = refusalCode('identity_link_denied');
const live = assertion<[hash: string, now: number]>({
  name: 'identity.linkLive',
  refusal: IDENTITY_LINK_DENIED, when: `EXISTS (SELECT 1 FROM identity_link_authorities
    WHERE key_hash=?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?2)`,
});
const refusal = `CASE
  WHEN EXISTS (SELECT 1 FROM members holder WHERE holder.github_id=?2 AND holder.id<>a.member_id) THEN 'identity_taken'
  WHEN m.id IS NULL OR m.revoked_at IS NOT NULL OR m.role NOT IN ('admin','member') THEN 'member_revoked'
  WHEN m.github_id IS NOT NULL AND m.github_id<>?2 THEN 'member_linked'
  WHEN NOT (${linkAdmitted('a.issued_by', 'a.member_id')}) THEN 'link_requires_admin'
  ELSE NULL END`;
const outcome = read<[hash: string, github: string], { reason: IdentityLinkRefusal | null }>({
  name: 'identity.linkOutcome',
  sql: `
  SELECT ${refusal} AS reason FROM identity_link_authorities a LEFT JOIN members m ON m.id=a.member_id WHERE a.key_hash=?1`,
});
const spend = write<[hash: string, github: string, now: number], { member_id: string }>({
  name: 'identity.linkSpend',
  sql: `
  UPDATE identity_link_authorities SET used_at=?3,used_by=?2 WHERE key_hash=?1
    AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?3 RETURNING member_id`,
});
const bind = write<[hash: string, github: string], { id: string; label: string | null; role: MemberRole }>({
  name: 'identity.linkBind',
  sql: `
  UPDATE members SET github_id=?2 WHERE id=(SELECT m.id FROM identity_link_authorities a
    LEFT JOIN members m ON m.id=a.member_id WHERE a.key_hash=?1 AND (${refusal}) IS NULL)
    RETURNING id,label,role`,
});
const owner = write<[hash: string, github: string]>({
  name: 'identity.linkOwner',
  sql: `
  UPDATE deployment_ownership SET member_id=(SELECT member_id FROM identity_link_authorities WHERE key_hash=?1),
    revision=revision+1,bootstrap_mode='selection'
  WHERE id=1 AND member_id IS NULL AND bootstrap_mode='fresh' AND changes()=1
    AND EXISTS (SELECT 1 FROM identity_link_authorities a JOIN members m ON m.id=a.member_id
      WHERE a.key_hash=?1 AND m.github_id=?2 AND ${linkedHumanAdminSql('m')})`,
});
const audit = write<[hash: string, now: number]>({
  name: 'identity.linkOwnerAudit',
  sql: `
  INSERT INTO deployment_ownership_audit(revision,member_id,actor_id,created_at)
    SELECT revision,member_id,member_id,?2 FROM deployment_ownership
    WHERE id=1 AND member_id=(SELECT member_id FROM identity_link_authorities WHERE key_hash=?1) AND changes()=1`,
});

export async function spendIdentityLink(db: RelationalStore, hash: string, github: string, now: number): Promise<IdentityLinkResult> {
  try {
    const [, result, spent, bound] = await commit(
      db,
      live.bind(hash, now),
      outcome.bind(hash, github),
      spend.bind(hash, github, now),
      bind.bind(hash, github),
      owner.bind(hash, github),
      audit.bind(hash, now),
    );
    if (spent.results.length !== 1 || result.results.length !== 1) throw new Error('Identity link outcome is missing');
    const reason = result.results[0]!.reason;
    if (reason !== null) return { ok: false, reason };
    const member = bound.results[0];
    if (member === undefined) throw new Error('Identity link binding is missing');
    return { ok: true, member };
  } catch (error) {
    if (refused(error, IDENTITY_LINK_DENIED)) return { ok: false, reason: 'denied' };
    throw error;
  }
}
