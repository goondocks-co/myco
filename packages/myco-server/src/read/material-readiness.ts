import type { RelationalStore } from '../core/adapters.js';
import { titleRunInFlightSql } from '../core/runs.js';
import { TITLING_MAX_ATTEMPTS } from '../constants.js';

/**
 * An automatic titling claim the session admits: under the attempt bound, and
 * either never attempted or an attempt that ended untitled — stamped before the
 * bound instant, with no title run of the session queued or running. Binds one
 * value, the latest stamp a retry may replace.
 */
export const titlingClaimAvailableSql = (alias: string): string => `(${alias}.titling_attempts < ${TITLING_MAX_ATTEMPTS} AND (${alias}.titled_at IS NULL OR (
  ${alias}.title IS NULL AND ${alias}.titled_at < ? AND NOT ${titleRunInFlightSql(alias)})))`;

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
