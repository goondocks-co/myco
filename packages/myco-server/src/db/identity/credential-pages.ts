import type { RelationalStore } from '../../core/adapters.js';
import { HARNESS_MEMBER_ID } from '../../constants.js';
import { credentialLive, runCredential } from '../liveness.js';
import { read, readSet } from '../index.js';

export interface CredentialPageRow {
  id: string;
  member_id: string;
  machine_id: string | null;
  runtime_label: string | null;
  expires_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  bytes_written: number;
  predecessor_id: string | null;
  lineage_root: string;
  lineage_started_at: number;
  first_used_at: number | null;
  live: number;
  run_credential: number;
}

const columns = `id,member_id,machine_id,COALESCE((SELECT mc.label FROM machine_claims mc WHERE mc.machine_id=member_credentials.machine_id),runtime_label) AS runtime_label,
  expires_at,revoked_at,revoked_by,bytes_written,predecessor_id,lineage_root,lineage_started_at,first_used_at,
  (${credentialLive('', '?1')}) AS live,(${runCredential('', '?2')}) AS run_credential`;
const order = 'ORDER BY lineage_started_at DESC,id DESC';

type Own = [now: number, harness: string, member: string, limit: number];
type OwnAfter = [now: number, harness: string, member: string, limit: number, startedAt: number, id: string];
const ownFirst = read<Own, CredentialPageRow>({ name: 'credentialPage.ownFirst', sql: `SELECT ${columns} FROM member_credentials INDEXED BY idx_member_credentials_member_started WHERE member_id=?3 ${order} LIMIT ?4` });
const ownAfter = read<OwnAfter, CredentialPageRow>({ name: 'credentialPage.ownAfter', sql: `SELECT ${columns} FROM member_credentials INDEXED BY idx_member_credentials_member_started WHERE member_id=?3 AND (lineage_started_at,id)<(?5,?6) ${order} LIMIT ?4` });

/** `purpose` narrows to the run credentials, or to the people's; `excluded` removes one member. */
const filtered = `(?3 IS NULL OR member_id<>?3) AND (?4 IS NULL OR (?4='run' AND member_id=?2) OR (?4='member' AND member_id<>?2))`;
type All = [now: number, harness: string, excluded: string | null, purpose: string | null, limit: number];
type AllAfter = [now: number, harness: string, excluded: string | null, purpose: string | null, limit: number, startedAt: number, id: string];
const allFirst = read<All, CredentialPageRow>({ name: 'credentialPage.allFirst', sql: `SELECT ${columns} FROM member_credentials INDEXED BY idx_member_credentials_started WHERE ${filtered} ${order} LIMIT ?5` });
const allAfter = read<AllAfter, CredentialPageRow>({ name: 'credentialPage.allAfter', sql: `SELECT ${columns} FROM member_credentials INDEXED BY idx_member_credentials_started WHERE ${filtered} AND (lineage_started_at,id)<(?6,?7) ${order} LIMIT ?5` });

export interface CredentialPageQuery {
  now: number;
  /** Rows to read, including the one that proves another page exists. */
  fetch: number;
  after: { createdAt: number; id: string } | null;
  purpose?: 'run' | 'member';
  memberId?: string;
  excludedMemberId?: string;
}

/** One member's credentials read their own index, so a page costs the page at any history size. */
export async function credentialPage(db: RelationalStore, query: CredentialPageQuery): Promise<CredentialPageRow[]> {
  const { now, fetch, after, purpose, memberId } = query;
  if (memberId !== undefined) {
    if (purpose !== undefined && (purpose === 'run') !== (memberId === HARNESS_MEMBER_ID)) return [];
    const [rows] = await readSet(db, after === null ? ownFirst.bind(now, HARNESS_MEMBER_ID, memberId, fetch) : ownAfter.bind(now, HARNESS_MEMBER_ID, memberId, fetch, after.createdAt, after.id));
    return rows;
  }
  const excluded = query.excludedMemberId ?? null;
  const named = purpose ?? null;
  const [rows] = await readSet(db, after === null ? allFirst.bind(now, HARNESS_MEMBER_ID, excluded, named, fetch) : allAfter.bind(now, HARNESS_MEMBER_ID, excluded, named, fetch, after.createdAt, after.id));
  return rows;
}
