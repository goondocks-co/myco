/**
 * Members, as the dashboard administers them.
 *
 * Membership is flat: any member may revoke any other, and the record names
 * who. Revoking a member is one transaction — the member row first, carrying
 * the one rule that holds the Deployment open, then every live credential,
 * unspent invitation and link key of that member, each conditioned on the
 * member row having changed in this very transaction. Machine claims are
 * permanent and untouched: a departed member's history stays theirs.
 */
import type { RelationalStore } from '../core/adapters.js';
import { emit } from '../telemetry.js';
import { revokeInvitationsOfMember } from './enrollment.js';
import { revokeLinkKeysOfMember } from './identity-link.js';
import { revokeCredentialsOfMember } from './tokens.js';

export interface MemberRow {
  id: string;
  label: string | null;
  /** Whether a GitHub account is connected. The account itself is never listed. */
  linked: boolean;
  createdAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  liveCredentials: number;
}

export async function listMembers(db: RelationalStore, nowMs: number): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(`SELECT m.id, m.label, m.github_id IS NOT NULL AS linked, m.created_at, m.revoked_at, m.revoked_by,
                     (SELECT COUNT(*) FROM member_credentials c WHERE c.member_id = m.id AND c.revoked_at IS NULL AND c.expires_at > ?) AS live_credentials
                FROM members m ORDER BY m.created_at ASC, m.id ASC`)
    .bind(nowMs)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: r.id as string,
    label: (r.label as string | null) ?? null,
    linked: Number(r.linked) === 1,
    createdAt: r.created_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    liveCredentials: Number(r.live_credentials),
  }));
}

export type MemberState = 'absent' | 'live' | 'revoked';

export async function memberState(db: RelationalStore, memberId: string): Promise<MemberState> {
  const row = await db.prepare(`SELECT revoked_at FROM members WHERE id = ?`).bind(memberId).first<{ revoked_at: number | null }>();
  if (row === null) return 'absent';
  return row.revoked_at === null ? 'live' : 'revoked';
}

export type RevokeMemberRefusal = 'absent' | 'already_revoked' | 'last_member';
export type RevokeMemberResult = { ok: true } | { ok: false; reason: RevokeMemberRefusal };

/**
 * Revokes a member and everything live that is theirs, in one transaction.
 *
 * The member statement runs first and refuses to leave the Deployment with no
 * live linked member; every later statement matches rows only when that first
 * one changed the member row. A refused revocation therefore changes nothing,
 * and the read afterwards only names which refusal it was.
 */
export async function revokeMember(db: RelationalStore, memberId: string, actor: string, nowMs: number): Promise<RevokeMemberResult> {
  const results = await db.batch([
    db.prepare(`UPDATE members SET revoked_at = ?, revoked_by = ?
                 WHERE id = ? AND revoked_at IS NULL
                   AND (SELECT COUNT(*) FROM members WHERE revoked_at IS NULL AND github_id IS NOT NULL AND id <> ?) >= 1`)
      .bind(nowMs, actor, memberId, memberId),
    revokeCredentialsOfMember(db, memberId, actor, nowMs),
    revokeInvitationsOfMember(db, memberId, actor, nowMs),
    revokeLinkKeysOfMember(db, memberId, actor, nowMs),
  ]);
  if (results[0]?.meta.changes === 1) {
    emit({ kind: 'member_revoked', memberId, actor });
    return { ok: true };
  }
  const state = await memberState(db, memberId);
  return { ok: false, reason: state === 'absent' ? 'absent' : state === 'revoked' ? 'already_revoked' : 'last_member' };
}
