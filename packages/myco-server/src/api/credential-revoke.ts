import type { ServerEnv } from '../core/adapters.js';
import type { CredentialContext } from '../context.js';
import { emptyBodyRoute } from '../auth/members.js';
import { revokeMemberLineage } from '../auth/tokens.js';
import { emit } from '../telemetry.js';

/** End every live token in the presented credential's lineage. */
export const handleMemberCredentialRevoke = emptyBodyRoute(async (env: ServerEnv, ctx: CredentialContext) => {
  const { revoked } = await revokeMemberLineage(env.db, ctx.tokenId, ctx.now, ctx.memberId);
  emit({ kind: 'credential_revoked', tokenId: ctx.tokenId, revokedBy: ctx.memberId, revoked: revoked > 0, rows: revoked });
  return Response.json({ persisted: true, revoked });
});
