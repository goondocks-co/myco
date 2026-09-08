/**
 * Pruning the raw transcript bytes a Deployment no longer needs to keep.
 *
 * The segments and their blobs are the ingest artifacts of a transcript, and
 * this module sits beside the parse that reads them: what a Deployment keeps
 * of the raw stream is an ingest concern, while everything DERIVED from it —
 * prompts, replies, tool calls, plans — is durable and is never pruned here.
 *
 * Two rules keep the sweep safe. A segment ahead of the parse cursor is kept
 * whatever its age, so bytes no pass has read are never the only copy of rows
 * that were never derived. And a blob is content-addressed and shared, so it
 * leaves the store only once nothing references it.
 */
import type { ServerEnv } from '../core/adapters.js';
import { leafValues } from '../core/settings.js';
import { JOB_BATCH } from '../core/jobs-run.js';
import { emit } from '../telemetry.js';

const DAY_MS = 86_400_000;


/** The widest retention window a Deployment may set, in days. */
export const TRANSCRIPT_RETENTION_MAX_DAYS = 3650;

/** What a Deployment's transcript window says, or null for indefinite. A value present and unreadable is refused rather than defaulted: a window that silently reverts prunes on a rule nobody wrote, and the operator never learns their setting did nothing. */
export function transcriptRetentionDays(raw: string | undefined): number | null | 'unreadable' {
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 'unreadable'; }
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > TRANSCRIPT_RETENTION_MAX_DAYS) return 'unreadable';
  return parsed === 0 ? null : parsed;
}

/**
 * No raw transcript segment outlives the Deployment's window, and a blob no
 * surviving row references goes with it. Derived rows are never pruned, and
 * neither is the transcript row: what the segments held is already projected,
 * and the record that they existed outlives the bytes.
 *
 * A segment ahead of the parse cursor is kept whatever its age. Pruning bytes
 * no pass has read yet would delete the only copy of rows that were never
 * derived.
 */
export async function transcriptRetention(env: ServerEnv, now: number): Promise<number> {
  const window = transcriptRetentionDays((await leafValues(env.db, ['retention.transcripts'])).get('retention.transcripts'));
  if (window === 'unreadable') {
    emit({ kind: 'transcript_retention_refused', reason: 'refused' });
    return 0;
  }
  if (window === null) return 0;

  const cutoff = now - window * DAY_MS;
  const { results: doomed } = await env.db
    .prepare(`SELECT s.project_id, s.transcript_id, s.base_offset, s.blob_key
                FROM transcript_segments s
                JOIN transcripts t ON t.project_id = s.project_id AND t.transcript_id = s.transcript_id
               WHERE s.created_at < ? AND t.parsed_offset >= s.base_offset + s.length
               ORDER BY s.created_at LIMIT ?`)
    .bind(cutoff, JOB_BATCH)
    .all<{ project_id: string; transcript_id: string; base_offset: number; blob_key: string }>();
  if (doomed.length === 0) return 0;

  await env.db.batch(doomed.map((d) => env.db
    .prepare(`DELETE FROM transcript_segments WHERE project_id = ? AND transcript_id = ? AND base_offset = ?`)
    .bind(d.project_id, d.transcript_id, d.base_offset)));

  // A blob is content-addressed and shared, so it goes only once nothing holds
  // it: an unconditional delete would take a surviving prompt's body with a
  // segment's.
  let freed = 0;
  for (const key of new Set(doomed.map((d) => d.blob_key))) {
    const project = doomed.find((d) => d.blob_key === key)!.project_id;
    const held = await env.db
      .prepare(`SELECT 1 AS present FROM transcript_segments WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM prompt_batches WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM responses WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM plans WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM attachments WHERE project_id = ? AND blob_key = ?`)
      .bind(project, key, project, key, project, key, project, key, project, key)
      .first<{ present: number }>();
    if (held !== null) continue;
    await env.blobs.delete(`${project}/${key}`);
    await env.db.prepare(`DELETE FROM blobs WHERE project_id = ? AND key = ?`).bind(project, key).run();
    freed += 1;
  }
  emit({ kind: 'transcript_retention_pruned', segments: doomed.length, blobs: freed });
  return doomed.length;
}
