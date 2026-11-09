import { personMemberSql } from '../../auth/member-kind.js';
import { memberWritePredicate, OWNER_CONTROL_CREDENTIAL_WRITE } from '../../auth/authorization.js';
import { carriedBytes } from '../../ingest/live-credential.js';
import { CREDENTIAL_INSERT_SQL } from '../runs/claim-companions.js';
import { assertion, refusalCode, write, type Bound } from '../index.js';

export const CREDENTIAL_NOT_REFRESHABLE = refusalCode('credential_not_refreshable');

/** A refresh may act only for a credential still live and rotating at this commit. */
const refreshable = assertion<[token: string]>({
  name: 'credential.refreshable', refusal: CREDENTIAL_NOT_REFRESHABLE,
  when: 'EXISTS (SELECT 1 FROM member_credentials WHERE id=?1 AND revoked_at IS NULL AND rotates=1)',
});
const retireBanked = write<[now: number, token: string]>({
  name: 'credential.retireBankedSuccessors',
  sql: 'UPDATE member_credentials SET revoked_at=?1 WHERE predecessor_id=?2 AND revoked_at IS NULL AND first_used_at IS NULL',
});
export const refreshableAssertion = (token: string): Bound => refreshable.bind(token);
export const retireBankedWrite = (now: number, token: string): Bound => retireBanked.bind(now, token);

/** A successor of this very predecessor, of the same member and machine and lineage, still live and unused at this commit. */
const HANDOFF_OPEN = `EXISTS (SELECT 1 FROM member_credentials successor
  JOIN member_credentials predecessor ON predecessor.id=successor.predecessor_id
  WHERE successor.id=?1 AND predecessor.id=?2
    AND successor.first_used_at IS NULL AND successor.revoked_at IS NULL
    AND successor.member_id=predecessor.member_id
    AND successor.machine_id IS predecessor.machine_id
    AND successor.lineage_root=predecessor.lineage_root)`;
const transferLeases = write<[successor: string, predecessor: string, now: number]>({
  name: 'credential.transferLeases',
  sql: `UPDATE agent_runs SET leased_by=?1 WHERE leased_by=?2 AND status='running' AND lease_expires_at>?3 AND ${HANDOFF_OPEN}`,
});
const stampFirstUse = write<[successor: string, predecessor: string, now: number], { id: string }>({
  name: 'credential.stampFirstUse',
  sql: `UPDATE member_credentials SET bytes_written=COALESCE(${carriedBytes('?2', '?3')},0),first_used_at=?3
    WHERE id=?1 AND first_used_at IS NULL AND revoked_at IS NULL RETURNING id`,
});
/** The predecessor ends only with a successor this very commit activated: a replaced successor ends nothing. */
const revokePredecessor = write<[successor: string, predecessor: string, now: number]>({
  name: 'credential.revokePredecessor',
  sql: `UPDATE member_credentials SET revoked_at=?3 WHERE id=?2 AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM member_credentials s WHERE s.id=?1 AND s.predecessor_id=?2 AND s.revoked_at IS NULL AND s.first_used_at=?3)`,
});
export function activationWrites(successor: string, predecessor: string, now: number): { leases: Bound; stamp: Bound<{ id: string }>; predecessor: Bound } {
  return {
    leases: transferLeases.bind(successor, predecessor, now),
    stamp: stampFirstUse.bind(successor, predecessor, now),
    predecessor: revokePredecessor.bind(successor, predecessor, now),
  };
}

const revokeLineage = write<[now: number, by: string, token: string], { id: string }>({
  name: 'credential.revokeLineage',
  sql: 'UPDATE member_credentials SET revoked_at = ?1, revoked_by = ?2 WHERE lineage_root = (SELECT lineage_root FROM member_credentials WHERE id = ?3) AND revoked_at IS NULL RETURNING id',
});
const OWNER_CONTROLLED = `${personMemberSql('member_credentials.member_id')} AND ${OWNER_CONTROL_CREDENTIAL_WRITE.replace('?', '?4')} AND ${memberWritePredicate('?4', 'member_credentials.member_id')}`;
const revokeLineageAsMember = write<[now: number, by: string, token: string, actor: string], { id: string }>({
  name: 'credential.revokeLineageAsMember',
  sql: `UPDATE member_credentials SET revoked_at=?1,revoked_by=?2 WHERE lineage_root=(SELECT lineage_root FROM member_credentials WHERE id=?3) AND revoked_at IS NULL AND ${OWNER_CONTROLLED} RETURNING id`,
});
const revokeMachineAsMember = write<[now: number, by: string, machine: string, actor: string], { id: string }>({
  name: 'credential.revokeMachineAsMember',
  sql: `UPDATE member_credentials SET revoked_at=?1,revoked_by=?2 WHERE machine_id=?3 AND revoked_at IS NULL AND ${OWNER_CONTROLLED}
    AND EXISTS (SELECT 1 FROM machine_claims mc WHERE mc.machine_id=member_credentials.machine_id AND mc.member_id=member_credentials.member_id) RETURNING id`,
});
export const revokeLineageWrite = (now: number, by: string, token: string): Bound<{ id: string }, 'write'> => revokeLineage.bind(now, by, token);
export const revokeLineageAsMemberWrite = (now: number, actor: string, token: string): Bound<{ id: string }, 'write'> => revokeLineageAsMember.bind(now, actor, token, actor);
export const revokeMachineAsMemberWrite = (now: number, actor: string, machine: string): Bound<{ id: string }, 'write'> => revokeMachineAsMember.bind(now, actor, machine, actor);

/** Mints a credential only for a member who does not administer the Deployment. */
export const nonAdminCredential = write<readonly unknown[], { id: string }>({
  name: 'enrollment.nonAdminCredential',
  sql: `${CREDENTIAL_INSERT_SQL} AND EXISTS (SELECT 1 FROM members WHERE id=? AND role='member') RETURNING id`,
});
