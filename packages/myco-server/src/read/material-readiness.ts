import type { RelationalStore } from '../core/adapters.js';

const UNREADY_TRANSCRIPT_SQL = `t.parsed_offset < t.size OR t.parse_error IS NOT NULL
  OR (t.fidelity IS NOT NULL AND t.fidelity <> 'full')`;

/** Every known transcript is fully parsed without a recorded failure or fidelity loss. */
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
