/**
 * Schema v59: a machine's name belongs to the machine.
 *
 * - `machine_claims.label` is the name the machine shows under. A join writes the host name the runtime sends when it
 *   first claims the machine and never after, so a later sign-in keeps a name someone gave it; a rename is one write
 *   to this row, which no credential's rotation or expiry touches.
 * - `idx_machine_claims_member` finds one member's machines: the reads that name a viewer's own machines and nobody
 *   else's, a member's page of machines, and the foreign key `member_id` has always carried to `members`.
 * - The backfill names each claimed machine after the label its newest credential carries, a live one ahead of any
 *   other. A machine whose credentials carry none keeps no name here, and its readers fall back to the newest live
 *   credential's label.
 */
export const V59_STATEMENTS: readonly string[] = [
  `ALTER TABLE machine_claims ADD COLUMN label TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_machine_claims_member ON machine_claims (member_id)`,
  `UPDATE machine_claims SET label = (
     SELECT c.runtime_label FROM member_credentials c
      WHERE c.machine_id = machine_claims.machine_id AND c.runtime_label IS NOT NULL
      ORDER BY (c.revoked_at IS NULL) DESC, c.issued_at DESC, c.id DESC LIMIT 1)
    WHERE label IS NULL`,
];
