import { enrollmentAuthorityPredicate } from '../auth/write-predicates.js';
import type { RelationalStore } from '../../core/adapters.js';
import { deploymentOwnerSql } from './ownership-policy.js';
import type { Page } from '../../read/scope.js';
import { clampLimit, decodeCursor, page } from '../../read/scope.js';
import { memberLive } from '../liveness.js';
import { read, readSet } from '../index.js';
import { lineageHeadsReady } from './lineage-heads.js';

/** A runtime count is `null` while heads build. */
export interface RuntimeFreshness { state: 'ready' | 'building'; asOf: number }

export interface MemberPageRow {
  id: string;
  label: string | null;
  role: string;
  role_revision: string | number;
  owner: number;
  linked: number;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  live_lineages: number;
}

const LIVE_HEADS = `FROM credential_lineages l INDEXED BY idx_credential_lineages_member_live WHERE l.member_id=m.id AND l.live_tokens>0 AND l.live_until>?1`;
const memberColumns = `m.id,m.label,m.role,m.role_revision,${deploymentOwnerSql('m.id')} AS owner,m.github_id IS NOT NULL AS linked,m.created_at,m.revoked_at,m.revoked_by,
  CASE WHEN m.revoked_at IS NULL THEN (SELECT COUNT(*) ${LIVE_HEADS}) ELSE 0 END AS live_lineages`;
const membersFirst = read<[now: number, limit: number], MemberPageRow>({
  name: 'memberPage.first', sql: `SELECT ${memberColumns} FROM members m INDEXED BY idx_members_created ORDER BY m.created_at ASC,m.id ASC LIMIT ?2`,
});
const membersAfter = read<[now: number, limit: number, createdAt: number, id: string], MemberPageRow>({
  name: 'memberPage.after', sql: `SELECT ${memberColumns} FROM members m INDEXED BY idx_members_created WHERE (m.created_at,m.id)>(?3,?4) ORDER BY m.created_at ASC,m.id ASC LIMIT ?2`,
});

interface MemberPage extends Page<MemberPageRow> { readonly countsReady: boolean }

/** One page of members, each with a key-bounded runtime count over its live heads, read beside the heads' readiness. */
export async function memberPage(db: RelationalStore, now: number, opts: { limit?: number; cursor?: string } = {}): Promise<MemberPage> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null, countsReady: false };
  const [ready, rows] = await readSet(db, lineageHeadsReady.bind(), after === null ? membersFirst.bind(now, limit + 1) : membersAfter.bind(now, limit + 1, after.createdAt, after.id));
  return { ...page(rows, limit, row => ({ createdAt: row.created_at, id: row.id })), countsReady: ready[0]?.done === 1 };
}

interface InvitationPageRow {
  id: string;
  member_id: string | null;
  created_by_member: string | null;
  created_at: number;
  expires_at: number;
  role: string;
  project_id: string | null;
}

const OPEN_INVITATIONS = `FROM enrollment_authorities INDEXED BY idx_enrollment_authorities_open WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at>?1
  AND (member_id IS NULL OR ${memberLive('enrollment_authorities.member_id')})
  AND (created_by_member IS NULL OR ${memberLive('enrollment_authorities.created_by_member')})
  AND ${enrollmentAuthorityPredicate('enrollment_authorities')}`;
const INVITATION_COLUMNS = 'id,member_id,created_by_member,created_at,expires_at,role,project_id';
const invitationsFirst = read<[now: number, limit: number], InvitationPageRow>({
  name: 'invitationPage.first', sql: `SELECT ${INVITATION_COLUMNS} ${OPEN_INVITATIONS} ORDER BY created_at DESC,id DESC LIMIT ?2`,
});
const invitationsAfter = read<[now: number, limit: number, createdAt: number, id: string], InvitationPageRow>({
  name: 'invitationPage.after', sql: `SELECT ${INVITATION_COLUMNS} ${OPEN_INVITATIONS} AND (created_at,id)<(?3,?4) ORDER BY created_at DESC,id DESC LIMIT ?2`,
});

export async function invitationPage(db: RelationalStore, now: number, opts: { limit?: number; cursor?: string } = {}): Promise<Page<InvitationPageRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const [rows] = await readSet(db, after === null ? invitationsFirst.bind(now, limit + 1) : invitationsAfter.bind(now, limit + 1, after.createdAt, after.id));
  return page(rows, limit, row => ({ createdAt: row.created_at, id: row.id }));
}

interface GrantPageRow {
  id: string;
  project_id: string;
  label: string | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  rotated_to: string | null;
}

const GRANT_COLUMNS = 'id,project_id,label,created_by,created_at,expires_at,last_used_at,revoked_at,revoked_by,rotated_to';
const GRANT_SOURCE = 'FROM external_grants INDEXED BY idx_external_grants_project WHERE project_id=?1';
const grantsFirst = read<[project: string, limit: number], GrantPageRow>({
  name: 'grantPage.first', sql: `SELECT ${GRANT_COLUMNS} ${GRANT_SOURCE} ORDER BY created_at DESC,id DESC LIMIT ?2`,
});
const grantsAfter = read<[project: string, limit: number, createdAt: number, id: string], GrantPageRow>({
  name: 'grantPage.after', sql: `SELECT ${GRANT_COLUMNS} ${GRANT_SOURCE} AND (created_at,id)<(?3,?4) ORDER BY created_at DESC,id DESC LIMIT ?2`,
});

export async function grantPage(db: RelationalStore, projectId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<GrantPageRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const [rows] = await readSet(db, after === null ? grantsFirst.bind(projectId, limit + 1) : grantsAfter.bind(projectId, limit + 1, after.createdAt, after.id));
  return page(rows, limit, row => ({ createdAt: row.created_at, id: row.id }));
}
