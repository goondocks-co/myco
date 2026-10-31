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
