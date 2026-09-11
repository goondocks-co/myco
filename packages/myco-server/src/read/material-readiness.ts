import type { RelationalStore } from '../core/adapters.js';
import { failedAutomaticTitleSql } from '../core/runs.js';

/** A first attempt, or a failed automatic attempt followed by newly captured live bytes. */
export const titlingClaimAvailableSql = (alias: string): string => `(${alias}.titled_at IS NULL OR (
  ${alias}.title IS NULL
  AND EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id
    AND t.last_received_at > ${alias}.titled_at AND t.imported_at IS NULL)
  AND ${failedAutomaticTitleSql(alias)}
))`;

const UNREADY_TRANSCRIPT_SQL = `t.parsed_offset < t.size OR t.parse_error IS NOT NULL`;

/** Every known transcript has finished parsing without a recorded failure. */
export const sessionMaterialReadySql = (alias: string): string => `NOT EXISTS (SELECT 1 FROM transcripts t
  WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND (${UNREADY_TRANSCRIPT_SQL}))`;

export class SessionMaterialPendingError extends Error {
  constructor() { super('Session capture is incomplete or has errors; retry after its transcripts are fully processed.'); }
}

/** Refuses known incomplete material; sessions with no transcript keep their projected-history behavior. */
export async function assertSessionMaterialReady(db: RelationalStore, projectId: string, sessionId: string): Promise<void> {
  const pending = await db.prepare(`SELECT 1 FROM transcripts t WHERE t.project_id = ? AND t.session_id = ?
    AND (${UNREADY_TRANSCRIPT_SQL}) LIMIT 1`).bind(projectId, sessionId).first();
  if (pending !== null) throw new SessionMaterialPendingError();
}
