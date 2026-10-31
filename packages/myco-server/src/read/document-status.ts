/**
 * The documents fact of the status surface: how many sessions are live or still converting, how far the publisher
 * stands behind the bytes received, the member events it has yet to publish, the superseded objects awaiting release,
 * and the conversion report's difference classes summed over every converted session. Each is one catalog statement.
 */
import type { RelationalStore } from '../core/adapters.js';

export interface DocumentStatus {
  sessions: { live: number; converting: number };
  lagBytes: number;
  queued: number;
  retired: number;
  differences: Record<string, number>;
}

export async function readDocumentStatus(db: RelationalStore): Promise<DocumentStatus> {
  const [states, lag, queued, retired, differences] = await db.batch([
    db.prepare(`SELECT state, COUNT(*) AS n FROM session_documents GROUP BY state`),
    db.prepare(`SELECT COALESCE(SUM(MAX(0, t.size - COALESCE(p.published_offset, 0))), 0) AS n FROM transcripts t
      JOIN session_documents d ON d.project_id = t.project_id AND d.session_id = t.session_id AND d.state = 'live'
      LEFT JOIN transcript_publication p ON p.project_id = t.project_id AND p.transcript_id = t.transcript_id AND p.generation = d.generation`),
    db.prepare(`SELECT COUNT(*) AS n FROM publish_queue`),
    db.prepare(`SELECT COUNT(*) AS n FROM retired_objects`),
    db.prepare(`SELECT c.key AS class, SUM(c.value) AS n FROM session_documents d, json_each(json_extract(d.build, '$.report.classes')) c
      WHERE d.state = 'live' AND json_valid(d.build) GROUP BY c.key`),
  ]);
  const count = (result: typeof queued) => Number((result!.results[0] as { n: number } | undefined)?.n ?? 0);
  const byState = new Map((states!.results as { state: string; n: number }[]).map((row) => [row.state, Number(row.n)]));
  return {
    sessions: { live: byState.get('live') ?? 0, converting: byState.get('convert') ?? 0 },
    lagBytes: count(lag), queued: count(queued), retired: count(retired),
    differences: Object.fromEntries((differences!.results as { class: string; n: number }[]).map((row) => [row.class, Number(row.n)])),
  };
}

/**
 * What the publisher has due: the transcripts its live publications stand behind and their unpublished bytes, and the
 * due sessions, each total also counted for the sessions whose every transcript arrived by import.
 */
export interface PublicationBacklog {
  sessions: number;
  transcripts: number;
  bytes: number;
  imported: { sessions: number; transcripts: number; bytes: number };
}

/** The live sessions due for publication, read through the publisher's due index, with their transcripts behind it. */
export async function pendingPublication(db: RelationalStore, now: number): Promise<PublicationBacklog> {
  const behind = `FROM transcripts t LEFT JOIN transcript_publication p ON p.project_id = t.project_id AND p.transcript_id = t.transcript_id
    AND p.generation = d.generation WHERE t.project_id = d.project_id AND t.session_id = d.session_id AND COALESCE(p.published_offset, 0) < t.size`;
  const row = await db.prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(imported), 0) AS imported_sessions,
      COALESCE(SUM(transcripts), 0) AS transcripts, COALESCE(SUM(bytes), 0) AS bytes,
      COALESCE(SUM(CASE WHEN imported = 1 THEN transcripts ELSE 0 END), 0) AS imported_transcripts,
      COALESCE(SUM(CASE WHEN imported = 1 THEN bytes ELSE 0 END), 0) AS imported_bytes
    FROM (SELECT (SELECT COUNT(*) ${behind}) AS transcripts,
        (SELECT COALESCE(SUM(t.size - COALESCE(p.published_offset, 0)), 0) ${behind}) AS bytes,
        EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = d.project_id AND t.session_id = d.session_id)
          AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = d.project_id AND t.session_id = d.session_id AND t.imported_at IS NULL) AS imported
      FROM session_documents d INDEXED BY idx_session_documents_due WHERE d.due_at <= ? AND d.state = 'live')`)
    .bind(now).first<Record<string, number>>();
  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    sessions: n('sessions'), transcripts: n('transcripts'), bytes: n('bytes'),
    imported: { sessions: n('imported_sessions'), transcripts: n('imported_transcripts'), bytes: n('imported_bytes') },
  };
}
