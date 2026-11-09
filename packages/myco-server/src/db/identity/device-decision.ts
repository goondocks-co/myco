import { assertion, refusalCode, write, type Bound } from '../index.js';

export const DEVICE_DECISION_REFUSED = refusalCode('device_decision_refused');

const decisionAdmitted = assertion<[id: string, now: number, subject: string | null, actor: string]>({
  name: 'device.decisionAdmitted', refusal: DEVICE_DECISION_REFUSED,
  when: `EXISTS (SELECT 1 FROM device_requests d WHERE d.id=?1 AND d.decision IS NULL AND d.expires_at>?2 AND (?3 IS NULL OR d.subject=?3)
      AND NOT EXISTS (SELECT 1 FROM device_decision_audit a WHERE a.request_id=d.id))
    AND EXISTS (SELECT 1 FROM members m WHERE m.id=?4 AND m.revoked_at IS NULL AND m.role IN ('admin','member')
      AND (m.role='admin' OR EXISTS (SELECT 1 FROM device_requests d WHERE d.id=?1 AND d.subject='member')))`,
});
/** The approving member's enrollment landed; an issuer the mint refused leaves the decision unmade. */
const enrollmentMinted = assertion<[id: string, actor: string]>({
  name: 'device.enrollmentMinted', refusal: DEVICE_DECISION_REFUSED,
  when: 'EXISTS (SELECT 1 FROM enrollment_authorities WHERE id=?1 AND created_by_member=?2)',
});
const decide = write<[decision: string, actor: string, now: number, id: string], { id: string }>({
  name: 'device.decide', sql: 'UPDATE device_requests SET decision=?1,decided_by=?2,decided_at=?3 WHERE id=?4 RETURNING id',
});
const decisionAudit = write<[sourceHash: string, id: string, decision: string, actor: string, now: number], { request_id: string }>({
  name: 'device.decisionAudit',
  sql: `INSERT INTO device_decision_audit(request_id,member_id,machine_id,machine_name,os,source_hash,decision,decided_at,subject)
    SELECT id,decided_by,machine_id,machine_name,os,?1,decision,decided_at,subject FROM device_requests
     WHERE id=?2 AND decision=?3 AND decided_by=?4 AND decided_at=?5 RETURNING request_id`,
});

interface DeviceDecision { id: string; now: number; decision: 'approved' | 'denied'; actor: string; sourceHash: string }

/** The statements of one decision. Only an approval has `minted`: it needs the enrollment its caller composes before it. */
export function deviceDecisionWrites({ id, now, decision, actor, sourceHash }: DeviceDecision): { admitted: Bound; minted?: Bound; decided: Bound; audit: Bound } {
  return {
    admitted: decisionAdmitted.bind(id, now, decision === 'approved' ? 'member' : null, actor),
    ...(decision === 'approved' ? { minted: enrollmentMinted.bind(id, actor) } : {}),
    decided: decide.bind(decision, actor, now, id),
    audit: decisionAudit.bind(sourceHash, id, decision, actor, now),
  };
}
