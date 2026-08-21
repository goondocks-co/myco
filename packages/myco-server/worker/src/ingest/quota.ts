import { MEMBER_TOKEN_BYTE_QUOTA } from '../constants.js';
import type { Fragment } from './projections.js';

/** The write in flight, as far as the quota is concerned: the token, its project, and the server clock the reservations are read against. */
export interface QuotaContext {
  projectId: string;
  tokenId: string;
  now: number;
}

/** What a token holds against its quota: what it has been charged (`member_tokens.bytes_written`: its stored event body bytes plus its stored blob bytes — the quantity the quota CHECK enforces) plus what its live blob reservations hold (all but `except`, a reservation the caller is re-sizing). The one expression for the held volume: every admission reads it, and a successor token takes it over from its predecessor at first use. */
export function heldBytes(ctx: QuotaContext, except: string | null = null): Fragment {
  return {
    sql: `(SELECT bytes_written FROM member_tokens WHERE id = ?)
          + (SELECT COALESCE(SUM(size), 0) FROM blob_reservations WHERE project_id = ? AND token_id = ? AND expires_at > ?${except === null ? '' : ' AND reservation_id != ?'})`,
    params: [ctx.tokenId, ctx.projectId, ctx.tokenId, ctx.now, ...(except === null ? [] : [except])],
  };
}

/** The one admission for the one counter: the token is live, and its held volume plus `bytes` stays inside the quota. Every writer of the counter — the event raw insert, the blob reservation, and the reservation reconcile — admits through this fragment and no other, so a token revoked after a request authenticated charges nothing: its raw insert writes no row and its upload fails at reconcile. */
export function withinQuota(ctx: QuotaContext, bytes: number, except: string | null = null): Fragment {
  const held = heldBytes(ctx, except);
  return {
    sql: `${held.sql}
          + ? <= ${MEMBER_TOKEN_BYTE_QUOTA}
          AND EXISTS (SELECT 1 FROM member_tokens WHERE id = ? AND revoked_at IS NULL)`,
    params: [...held.params, bytes, ctx.tokenId],
  };
}
