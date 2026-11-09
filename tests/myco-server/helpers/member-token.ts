import { mintWrite, NO_RUNTIME_CLAIMS, type RuntimeClaims } from '@myco-server-worker/auth/tokens.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { prepareBound } from '@myco-server-worker/db/kernel/statement.js';

/** A real mint, standing in for a machine that joined: its lineage, runtime claims and rotation as the test needs them. */
export async function issueMemberToken(
  db: RelationalStore, member: { memberId: string; machineId: string | null }, nowMs: number,
  lineage: { predecessorId: string; lineageRoot: string; lineageStartedAt: number } | null = null, runtime: RuntimeClaims = NO_RUNTIME_CLAIMS,
  options: { rotates?: boolean } = {},
): Promise<{ token: string; tokenId: string; expiresAt: number }> {
  const { statement, issued } = await mintWrite(db, member, nowMs, lineage, runtime, options);
  await prepareBound(db, statement).run();
  return issued;
}
