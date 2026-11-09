import type { RelationalStore } from '../../core/adapters.js';
import { first, read, readSet } from '../index.js';
import { credentialLive } from '../liveness.js';
import { notTombstonedSql } from '../session-read-model.js';

export interface ClaimRow {
  machine_id: string;
  member_id: string;
  claimed_at: number;
  label: string | null;
  member_label: string | null;
  member_revoked_at: number | null;
}

const CLAIM_COLUMNS = 'mc.machine_id, mc.member_id, mc.claimed_at, mc.label, m.label AS member_label, m.revoked_at AS member_revoked_at';
const AFTER = (at: string, id: string): string => `AND (mc.claimed_at < ${at} OR (mc.claimed_at = ${at} AND mc.machine_id > ${id}))`;
const ORDER = 'ORDER BY mc.claimed_at DESC, mc.machine_id ASC';

const allClaims = read<[limit: number], ClaimRow>({ name: 'runners.claimsAll', sql:
  `SELECT ${CLAIM_COLUMNS} FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id WHERE 1=1 ${ORDER} LIMIT ?1` });
const allClaimsAfter = read<[limit: number, at: number, id: string], ClaimRow>({ name: 'runners.claimsAllAfter', sql:
  `SELECT ${CLAIM_COLUMNS} FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id WHERE 1=1 ${AFTER('?2', '?3')} ${ORDER} LIMIT ?1` });
const memberClaims = read<[member: string, limit: number], ClaimRow>({ name: 'runners.claimsOfMember', sql:
  `SELECT ${CLAIM_COLUMNS} FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id WHERE mc.member_id = ?1 ${ORDER} LIMIT ?2` });
const memberClaimsAfter = read<[member: string, limit: number, at: number, id: string], ClaimRow>({ name: 'runners.claimsOfMemberAfter', sql:
  `SELECT ${CLAIM_COLUMNS} FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id WHERE mc.member_id = ?1 ${AFTER('?3', '?4')} ${ORDER} LIMIT ?2` });

export type ClaimScope = { all: true } | { all: false; memberId: string };

/** One page of claims in immutable claim order; credential history never drives it. */
export async function claimPage(db: RelationalStore, scope: ClaimScope, limit: number, after: { createdAt: number; id: string } | null): Promise<ClaimRow[]> {
  const bound = scope.all
    ? (after === null ? allClaims.bind(limit) : allClaimsAfter.bind(limit, after.createdAt, after.id))
    : (after === null ? memberClaims.bind(scope.memberId, limit) : memberClaimsAfter.bind(scope.memberId, limit, after.createdAt, after.id));
  return (await readSet(db, bound))[0];
}

export interface CredentialFactsRow {
  machine_id: string;
  credential_count: number;
  live_count: number;
  bytes_written: number;
  first_seen_at: number;
  newest_revoked_at: number | null;
  newest_revoked_by: string | null;
  live_label: string | null;
}

const credentialFacts = read<[now: number, machines: string], CredentialFactsRow>({ name: 'runners.machineCredentialFacts', sql:
  `SELECT c.machine_id, COUNT(*) AS credential_count,
      SUM(CASE WHEN ${credentialLive('c', '?1')} THEN 1 ELSE 0 END) AS live_count,
      SUM(CASE WHEN c.lineage_rank = 1 THEN c.bytes_written ELSE 0 END) AS bytes_written,
      MIN(c.lineage_started_at) AS first_seen_at,
      (SELECT n.revoked_at FROM member_credentials n WHERE n.machine_id = c.machine_id ORDER BY n.issued_at DESC, n.id DESC LIMIT 1) AS newest_revoked_at,
      (SELECT n.revoked_by FROM member_credentials n WHERE n.machine_id = c.machine_id ORDER BY n.issued_at DESC, n.id DESC LIMIT 1) AS newest_revoked_by,
      (SELECT n.runtime_label FROM member_credentials n WHERE n.machine_id = c.machine_id AND ${credentialLive('n', '?1')} AND n.runtime_label IS NOT NULL ORDER BY n.issued_at DESC, n.id DESC LIMIT 1) AS live_label
    FROM (SELECT c.machine_id, c.member_id, c.revoked_at, c.expires_at, c.bytes_written, c.lineage_started_at,
      ROW_NUMBER() OVER (PARTITION BY c.machine_id, c.lineage_root ORDER BY c.issued_at DESC, c.id DESC) AS lineage_rank
     FROM member_credentials c INDEXED BY idx_member_credentials_machine
     WHERE c.machine_id IN (SELECT value FROM json_each(?2))) c GROUP BY c.machine_id` });
export const machineCredentialFacts = async (db: RelationalStore, now: number, machineIds: readonly string[]): Promise<CredentialFactsRow[]> =>
  (await readSet(db, credentialFacts.bind(now, JSON.stringify(machineIds))))[0];

export interface MachineEventRow { event_id: string; project_id: string; session_id: string; kind: string; created_at: number; received_at: number }

/** The newest events a machine wrote: an anchor credential's page, then each other credential's page down to it, so older credentials cost one seek. */
const activitySql = (window: string): string => {
  const columns = 'event_id,project_id,session_id,kind,created_at,received_at';
  const head = 'SELECT id FROM heads WHERE at IS NOT NULL ORDER BY at DESC,id LIMIT 1';
  return `WITH args(machine,n,at,pid,eid) AS (VALUES(?1,?2,?3,?4,?5)),
    heads AS MATERIALIZED (
      SELECT c.id,(SELECT e.created_at FROM events e INDEXED BY idx_events_token_only
        WHERE e.token_id=c.id ${window} ORDER BY e.created_at DESC LIMIT 1) AS at
      FROM member_credentials c WHERE c.machine_id=(SELECT machine FROM args)),
    anchor AS MATERIALIZED (
      SELECT ${columns} FROM events e INDEXED BY idx_events_token_only
      WHERE e.token_id=(${head}) ${window}
      ORDER BY created_at DESC,project_id DESC,event_id DESC LIMIT (SELECT n FROM args)),
    bounds AS MATERIALIZED (SELECT MAX(at) AS at FROM (
      SELECT MIN(created_at) AS at FROM anchor HAVING COUNT(*)=(SELECT n FROM args)
      UNION ALL SELECT at FROM (SELECT at FROM heads WHERE at IS NOT NULL ORDER BY at DESC LIMIT 1 OFFSET (SELECT n-1 FROM args)))),
    candidates AS MATERIALIZED (
      SELECT ${columns} FROM anchor UNION ALL
      SELECT json_extract(j.value,'$.event_id'),json_extract(j.value,'$.project_id'),json_extract(j.value,'$.session_id'),
        json_extract(j.value,'$.kind'),json_extract(j.value,'$.created_at'),json_extract(j.value,'$.received_at')
      FROM heads h CROSS JOIN bounds b CROSS JOIN json_each((
        SELECT json_group_array(json_object('event_id',event_id,'project_id',project_id,'session_id',session_id,
          'kind',kind,'created_at',created_at,'received_at',received_at)) FROM (
          SELECT ${columns} FROM events e INDEXED BY idx_events_token_only WHERE e.token_id=h.id ${window}
            AND e.created_at>=COALESCE(b.at,${Number.MIN_SAFE_INTEGER})
          ORDER BY created_at DESC,project_id DESC,event_id DESC LIMIT (SELECT n FROM args)))) j
      WHERE h.id<>(${head}) AND h.at IS NOT NULL AND (b.at IS NULL OR h.at>=b.at))
    SELECT * FROM candidates ORDER BY created_at DESC,project_id DESC,event_id DESC LIMIT (SELECT n FROM args)`;
};
type ActivitySlots = [machine: string, limit: number, at: number | null, project: string | null, event: string | null];
const LIVE_EVENT = `AND ${notTombstonedSql('e')}`;
const firstActivity = read<ActivitySlots, MachineEventRow>({ name: 'runners.machineActivity', sql: activitySql(LIVE_EVENT) });
const nextActivity = read<ActivitySlots, MachineEventRow>({ name: 'runners.machineActivityAfter', sql: activitySql(`${LIVE_EVENT} AND e.created_at<=(SELECT at FROM args)
    AND (e.created_at,e.project_id,e.event_id)<(SELECT at,pid,eid FROM args)`) });

export const machineEvents = async (db: RelationalStore, machineId: string, limit: number, after: { at: number; project: string; event: string } | null): Promise<MachineEventRow[]> =>
  (await readSet(db, after === null ? firstActivity.bind(machineId, limit, null, null, null) : nextActivity.bind(machineId, limit, after.at, after.project, after.event)))[0];

const claimFound = read<[machine: string], { found: number }>({ name: 'runners.claimExists', sql: 'SELECT 1 AS found FROM machine_claims WHERE machine_id = ?1' });
const ownClaimFound = read<[machine: string, member: string], { found: number }>({ name: 'runners.ownClaimExists', sql: 'SELECT 1 AS found FROM machine_claims WHERE machine_id = ?1 AND member_id = ?2' });
export const machineClaimed = async (db: RelationalStore, machineId: string, scope: ClaimScope): Promise<boolean> =>
  await first(db, scope.all ? claimFound.bind(machineId) : ownClaimFound.bind(machineId, scope.memberId)) !== null;

const memberMachines = read<[member: string], { machine_id: string }>({ name: 'runners.memberMachines', sql: 'SELECT machine_id FROM machine_claims WHERE member_id = ?1' });
export const claimedMachineIds = async (db: RelationalStore, memberId: string): Promise<Set<string>> =>
  new Set((await readSet(db, memberMachines.bind(memberId)))[0].map(row => row.machine_id));
