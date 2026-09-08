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
import { emit } from '../telemetry.js';

const DAY_MS = 86_400_000;

/**
 * Store and blob calls one sweep may spend, in the same units the parse pass
 * counts (`ingest/parse.ts`).
 *
 * Freeing a blob is three calls — the reference check, the object delete, the
 * row delete — so a sweep that took a large page and freed each key in turn
 * would spend thousands in one invocation against a cap of fifty. The window
 * does not move between ticks, so what this sweep leaves the next one takes.
 */
export const TRANSCRIPT_RETENTION_CALLS_PER_PASS = 12;
/** Segments removed in one statement. The deletes are one call whatever the page holds; the blobs behind them are not. */
export const TRANSCRIPT_RETENTION_SEGMENTS_PER_PASS = 100;


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
  let calls = 1;
  const { results: doomed } = await env.db
    .prepare(`SELECT s.project_id, s.transcript_id, s.base_offset, s.blob_key
                FROM transcript_segments s
                JOIN transcripts t ON t.project_id = s.project_id AND t.transcript_id = s.transcript_id
               WHERE s.created_at < ? AND t.parsed_offset >= s.base_offset + s.length
               ORDER BY s.created_at LIMIT ?`)
    .bind(cutoff, TRANSCRIPT_RETENTION_SEGMENTS_PER_PASS)
    .all<{ project_id: string; transcript_id: string; base_offset: number; blob_key: string }>();
  calls += 1;
  if (doomed.length === 0) return 0;

  // Every segment of the page in one call: the rows are what the window names,
  // and leaving some behind would re-select them next tick for no gain.
  await env.db.batch(doomed.map((d) => env.db
    .prepare(`DELETE FROM transcript_segments WHERE project_id = ? AND transcript_id = ? AND base_offset = ?`)
    .bind(d.project_id, d.transcript_id, d.base_offset)));
  calls += 1;

  emit({ kind: 'transcript_retention_pruned', segments: doomed.length, blobs: await freeBlobs(env, doomed, calls) });
  return doomed.length;
}

/**
 * Remove the blobs the swept segments named, as far as the budget reaches.
 *
 * A blob is content-addressed and shared, so it goes only once nothing holds
 * it: an unconditional delete would take a surviving prompt's body with a
 * segment's. What the budget does not reach stays referenced by nothing and is
 * taken by a later tick — the same page re-selects nothing, so the sweep below
 * finds these keys again through the segments still naming them or, once those
 * are gone, through the orphan pass.
 */
async function freeBlobs(
  env: Pick<ServerEnv, 'db' | 'blobs'>, doomed: readonly { project_id: string; blob_key: string }[], spent: number,
): Promise<number> {
  let calls = spent;
  let freed = 0;
  const keys = new Map<string, string>();
  for (const d of doomed) if (!keys.has(d.blob_key)) keys.set(d.blob_key, d.project_id);
  for (const [key, project] of keys) {
    if (calls + 3 > TRANSCRIPT_RETENTION_CALLS_PER_PASS) break;
    const held = await env.db
      .prepare(`SELECT 1 AS present FROM transcript_segments WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM prompt_batches WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM responses WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM plans WHERE project_id = ? AND blob_key = ?
                 UNION SELECT 1 FROM attachments WHERE project_id = ? AND blob_key = ?`)
      .bind(project, key, project, key, project, key, project, key, project, key)
      .first<{ present: number }>();
    calls += 1;
    if (held !== null) continue;
    await env.blobs.delete(`${project}/${key}`);
    await env.db.prepare(`DELETE FROM blobs WHERE project_id = ? AND key = ?`).bind(project, key).run();
    calls += 2;
    freed += 1;
  }
  return freed;
}
