import type { PreparedStatement, RelationalStore } from './adapters.js';
/** SQL projections of historical credential and machine evidence. */
export const rawCredentialOwner = (token: string, machine?: string): string => `(SELECT credential.member_id FROM member_credentials credential
  WHERE credential.id = ${token} AND credential.machine_id IS NOT NULL
    ${machine ? `AND credential.machine_id = ${machine}` : ''}
    AND NOT EXISTS (SELECT 1 FROM machine_claims mc WHERE mc.machine_id = credential.machine_id AND mc.member_id <> credential.member_id))`;

export const rawTranscriptOwner = (alias: string): string => `(SELECT mc.member_id FROM machine_claims mc
  WHERE mc.machine_id = ${alias}.machine_id
    AND ${alias}.segment_count = (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.project_id = ${alias}.project_id AND ts.transcript_id = ${alias}.transcript_id)
    AND NOT EXISTS (SELECT 1 FROM member_credentials c WHERE c.id = ${alias}.token_id
      AND (c.member_id <> mc.member_id OR c.machine_id IS NULL OR c.machine_id <> ${alias}.machine_id))
    AND NOT EXISTS (SELECT 1 FROM transcript_segments ts LEFT JOIN member_credentials c ON c.id = ts.token_id
      WHERE ts.project_id = ${alias}.project_id AND ts.transcript_id = ${alias}.transcript_id
        AND (c.id IS NULL OR c.member_id <> mc.member_id OR c.machine_id IS NULL OR c.machine_id <> ${alias}.machine_id)))`;

/** The ownership reference of one verified upload while its reservation still holds. */
export function verifiedBlobReference(db: RelationalStore, upload: { projectId: string; key: string; tokenId: string; reservationId: string; at: number }): PreparedStatement {
  return db.prepare(`INSERT INTO raw_resources (project_id, kind, resource_id, reference_id, owner_member_id, machine_id, token_id)
    SELECT ?, 'blob', ?, c.id, ${rawCredentialOwner('c.id')}, c.machine_id, c.id FROM member_credentials c
      WHERE c.id = ? AND c.machine_id IS NOT NULL AND c.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id = ? AND expires_at > ?)
        AND EXISTS (SELECT 1 FROM blobs WHERE project_id = ? AND key = ?) ON CONFLICT DO NOTHING`)
    .bind(upload.projectId, upload.key, upload.tokenId, upload.reservationId, upload.at, upload.projectId, upload.key);
}
