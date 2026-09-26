import type { RelationalStore } from '../core/adapters.js';
import type { Fragment } from './projections.js';

/**
 * What a member's capture is admitted by: its credential is still live. Nothing
 * else about the credential is an admission. Capture is never refused for
 * volume: `member_credentials.bytes_written` is a reporting counter, charged for
 * every stored event body and blob byte and carried to a rotated successor, and
 * no admission compares it (#1416). Abuse is bounded by the per-request size caps
 * (`body_cap`, `blob_cap`), the token and source rate limits, and revocation.
 */

/** An admission that always holds, in the fragment shape every other admission takes. What a write the Deployment makes for itself is admitted by: it names no credential to be live. */
export const ALWAYS: Fragment = { sql: '1 = 1', params: [] };

/** A token that is still live, as SQL over one bound id: the one predicate the capture admission, the successor insert, and the refresh batch place on the token they act for. */
export const TOKEN_LIVE = 'EXISTS (SELECT 1 FROM member_credentials WHERE id = ? AND revoked_at IS NULL)';

/** The one admission a member's capture carries: the event raw insert, the blob reservation and the reservation reconcile all read this fragment, so a token revoked after a request authenticated admits nothing more — its raw insert writes no row and its upload is never registered. */
export function credentialLive(tokenId: string): Fragment {
  return { sql: TOKEN_LIVE, params: [tokenId] };
}

/** The bytes a credential has stored — its event bodies and blobs, and its predecessors' carried at rotation — or null when no credential row carries the id. Reported, never compared. */
export async function storedBytes(db: RelationalStore, tokenId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT bytes_written FROM member_credentials WHERE id = ?`).bind(tokenId).first<{ bytes_written: number }>();
  return row?.bytes_written ?? null;
}

/**
 * What a rotated successor takes over from its predecessor, as SQL: the
 * predecessor's stored-bytes count plus its live blob reservations. An upload
 * in flight at rotation still registers against the predecessor's row, which
 * nothing reads again, so its bytes are counted once in the lineage by being
 * carried here. A count, never an admission.
 */
export function carriedBytes(predecessorId: string, now: number): Fragment {
  return {
    sql: `(SELECT bytes_written FROM member_credentials WHERE id = ?)
          + (SELECT COALESCE(SUM(size), 0) FROM blob_reservations WHERE token_id = ? AND expires_at > ?)`,
    params: [predecessorId, predecessorId, now],
  };
}
