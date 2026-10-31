import type { RelationalStore } from '../core/adapters.js';
import { titleRunInFlightSql } from '../db/session-read-model.js';
import { TITLING_MAX_ATTEMPTS } from '../constants.js';

/**
 * An automatic titling claim the session admits: under the attempt bound, and
 * either never attempted or an attempt that ended untitled — stamped before the
 * bound instant, with no title run of the session queued or running. Binds one
 * value, the latest stamp a retry may replace.
 */
export const titlingClaimAvailableSql = (alias: string): string => `(${alias}.titling_attempts < ${TITLING_MAX_ATTEMPTS} AND (${alias}.titled_at IS NULL OR (
  ${alias}.title IS NULL AND ${alias}.titled_at < ? AND NOT ${titleRunInFlightSql(alias)})))`;

/**
 * Every known transcript of the session is published to its size in the live document without a stopped publication.
 * A title write requires this alone, so member events arriving while a run titles the session never refuse its write.
 */
export const transcriptsPublishedSql = (alias: string): string => `NOT EXISTS (SELECT 1 FROM transcripts t
    WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND NOT EXISTS (SELECT 1 FROM session_documents d
      JOIN transcript_publication p ON p.project_id = d.project_id AND p.generation = d.generation AND p.transcript_id = t.transcript_id
      WHERE d.project_id = t.project_id AND d.session_id = t.session_id AND d.state = 'live' AND p.published_offset >= t.size AND p.state <> 'failed'))`;

/**
 * The publisher has caught up with the session: its transcripts are published, and no member event of the session waits
 * in the publish queue. Titling material is read only then.
 */
export const sessionMaterialReadySql = (alias: string): string => `(${transcriptsPublishedSql(alias)}
  AND NOT EXISTS (SELECT 1 FROM publish_queue q WHERE q.project_id = ${alias}.project_id AND q.session_id = ${alias}.session_id))`;

export class SessionMaterialPendingError extends Error {
  constructor() { super('Session capture is incomplete or has errors; retry after its transcripts are fully published.'); }
}

/** Refuses a session whose publisher has not caught up with it. */
export async function assertSessionMaterialReady(db: RelationalStore, projectId: string, sessionId: string): Promise<void> {
  const row = await db.prepare(`SELECT ${sessionMaterialReadySql('x')} AS ready FROM (SELECT ? AS project_id, ? AS session_id) x`)
    .bind(projectId, sessionId).first<{ ready: number }>();
  if (row?.ready !== 1) throw new SessionMaterialPendingError();
}
