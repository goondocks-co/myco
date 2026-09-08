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
 *
 * One orphan this does not reach: a blob uploaded whose event is then refused
 * belongs to no row and follows no deletion, so nothing signals it. That gap
 * predates this module and needs a sweep walking the store rather than the rows.
 */
import type { ServerEnv } from '../core/adapters.js';
import { leafValues } from '../core/settings.js';
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
 * How many blobs one sweep frees, and so how many segments it removes.
 *
 * A segment row is the only route back to the blob it names, so a sweep that
 * deleted more segments than it could free blobs for would strand the rest with
 * nothing left pointing at them. The page is therefore sized by the blobs, not
 * the rows: what this pass does not take, the next selects again unchanged.
 */
export const TRANSCRIPT_RETENTION_BLOBS_PER_PASS = 8;
/** Candidate rows read before the page is cut to the blobs above; several segments may name one blob. */
const CANDIDATE_SEGMENTS = 256;

/**
 * Store and blob calls one sweep may spend, in the units the parse pass counts.
 *
 * Worst case: the leaf, the orphan select, its object deletes and one batched
 * row delete, the candidate select, one batched segment delete, one reference
 * check, and the page's object deletes with one batched row delete. Both
 * halves are bounded by `TRANSCRIPT_RETENTION_BLOBS_PER_PASS`, which is what
 * keeps the total inside a hosted runtime's per-invocation cap alongside the
 * other jobs.
 */
export const TRANSCRIPT_RETENTION_CALLS_PER_PASS = 2 * TRANSCRIPT_RETENTION_BLOBS_PER_PASS + 6;

/**
 * No raw transcript segment outlives the Deployment's window, and a blob no
 * surviving row references goes with it. Derived rows are never pruned, and
 * neither is the transcript row: what the segments held is already projected,
 * and the record that they existed outlives the bytes.
 *
 * A segment ahead of the parse cursor is kept whatever its age. Pruning bytes
 * no pass has read would delete the only copy of rows that were never derived.
 *
 * Complete by construction: every segment this pass deletes has had the blob it
 * names considered in the same pass, so nothing is left unreferenced and
 * unreachable.
 */
export async function transcriptRetention(env: ServerEnv, now: number): Promise<number> {
  // Orphans first, and regardless of the window: a deleted session frees a
  // bounded page of blobs and the rows naming the rest are already gone, so
  // this is the only route back to them. Whether a Deployment keeps its raw
  // segments for thirty days or forever says nothing about bytes nothing
  // references at all.
  //
  // Gated, though. The steady state is that there are no orphans, and asking
  // costs a scan of `blobs` against five reference checks — cheap per row and
  // paid on every tick forever. A deletion is the only thing that makes an
  // orphan, so the sweep runs only where one has happened recently.
  const orphans = (await orphansPossible(env.db, now)) ? await freeOrphanedBlobs(env) : 0;

  const window = transcriptRetentionDays((await leafValues(env.db, ['retention.transcripts'])).get('retention.transcripts'));
  if (window === 'unreadable') {
    emit({ kind: 'transcript_retention_refused', reason: 'refused' });
    return orphans;
  }
  if (window === null) return orphans;

  const cutoff = now - window * DAY_MS;
  const { results: candidates } = await env.db
    .prepare(`SELECT s.project_id, s.transcript_id, s.base_offset, s.blob_key
                FROM transcript_segments s
                JOIN transcripts t ON t.project_id = s.project_id AND t.transcript_id = s.transcript_id
               WHERE s.created_at < ? AND t.parsed_offset >= s.base_offset + s.length
               ORDER BY s.created_at LIMIT ?`)
    .bind(cutoff, CANDIDATE_SEGMENTS)
    .all<{ project_id: string; transcript_id: string; base_offset: number; blob_key: string }>();
  if (candidates.length === 0) return 0;

  // Cut the page to the blobs this pass can account for, then take every
  // segment naming one of them: the rows and the objects go together.
  // A blob key is unique per Project, not across them: the same content in two
  // Projects is two rows and two objects, and a page keyed by content alone
  // would delete one Project's segment while accounting for another's blob.
  const at = (projectId: string, key: string) => `${projectId}\u0000${key}`;
  const admitted = new Map<string, { projectId: string; key: string }>();
  for (const c of candidates) {
    const id = at(c.project_id, c.blob_key);
    if (!admitted.has(id) && admitted.size >= TRANSCRIPT_RETENTION_BLOBS_PER_PASS) continue;
    admitted.set(id, { projectId: c.project_id, key: c.blob_key });
  }
  const doomed = candidates.filter((c) => admitted.has(at(c.project_id, c.blob_key)));

  await env.db.batch(doomed.map((d) => env.db
    .prepare(`DELETE FROM transcript_segments WHERE project_id = ? AND transcript_id = ? AND base_offset = ?`)
    .bind(d.project_id, d.transcript_id, d.base_offset)));

  emit({ kind: 'transcript_retention_pruned', segments: doomed.length, blobs: await freeBlobs(env, admitted) });
  return doomed.length + orphans;
}

/**
 * Whether a deletion has happened that could have left a blob behind.
 *
 * A tombstone is the only writer that removes rows naming a blob while leaving
 * the blob, so its own record is the signal. Reading it walks a table holding
 * one row per deleted session — small on every Deployment, and unindexed on
 * `created_at`, so this is a scan of that table rather than a seek. The sweep it
 * guards is a scan of every blob in the Deployment against five reference
 * checks. Paying the first on every tick to skip the second is the whole point.
 *
 * A sweep runs for every tombstone newer than the window it last swept, and
 * `TOMBSTONE_SWEEP_GRACE_MS` keeps it running for a while afterwards so a
 * deletion whose blobs took several passes to drain is finished rather than
 * abandoned.
 */
export const TOMBSTONE_SWEEP_GRACE_MS = 6 * 60 * 60 * 1000;

async function orphansPossible(db: ServerEnv['db'], now: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM session_tombstones WHERE created_at > ? LIMIT 1`)
    .bind(now - TOMBSTONE_SWEEP_GRACE_MS)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Blobs no row anywhere references, removed a bounded page at a time.
 *
 * A session's deletion frees what it can and leaves the rest, and the rows that
 * named those blobs are gone with it — so nothing but this walks them. Bounded
 * and repeated rather than exhaustive: the next tick selects what this one left.
 */
export async function freeOrphanedBlobs(env: Pick<ServerEnv, 'db' | 'blobs'>): Promise<number> {
  const holders = ['transcript_segments', 'prompt_batches', 'responses', 'plans', 'attachments'];
  const unreferenced = holders.map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE project_id = b.project_id AND blob_key = b.key)`).join(' AND ');
  const { results } = await env.db
    .prepare(`SELECT project_id, key FROM blobs b WHERE ${unreferenced} LIMIT ?`)
    .bind(TRANSCRIPT_RETENTION_BLOBS_PER_PASS)
    .all<{ project_id: string; key: string }>();
  if (results.length === 0) return 0;
  for (const row of results) await env.blobs.delete(`${row.project_id}/${row.key}`);
  await env.db.batch(results.map((row) => env.db
    .prepare(`DELETE FROM blobs WHERE project_id = ? AND key = ?`).bind(row.project_id, row.key)));
  emit({ kind: 'orphaned_blobs_freed', blobs: results.length });
  return results.length;
}

/**
 * Remove the blobs the swept segments named, once nothing else holds them.
 *
 * A blob is content-addressed and shared, so an unconditional delete would take
 * a surviving prompt's body with a segment's. The reference check covers every
 * admitted key in one statement rather than one apiece, which is what lets a
 * whole page be accounted for inside the call budget.
 */
async function freeBlobs(env: Pick<ServerEnv, 'db' | 'blobs'>, admitted: ReadonlyMap<string, { projectId: string; key: string }>): Promise<number> {
  const page = [...admitted.values()];
  if (page.length === 0) return 0;
  const holders = ['transcript_segments', 'prompt_batches', 'responses', 'plans', 'attachments'];
  // Every reference check carries the Project, so a key held in one Project
  // cannot keep the same content alive in another.
  const pairs = page.map(() => '(project_id = ? AND blob_key = ?)').join(' OR ');
  const { results: held } = await env.db
    .prepare(holders.map((table) => `SELECT DISTINCT project_id AS p, blob_key AS k FROM ${table} WHERE ${pairs}`).join(' UNION '))
    .bind(...holders.flatMap(() => page.flatMap((b) => [b.projectId, b.key])))
    .all<{ p: string; k: string }>();

  const stillHeld = new Set(held.map((r) => `${r.p}\u0000${r.k}`));
  const orphaned = page.filter((b) => !stillHeld.has(`${b.projectId}\u0000${b.key}`));
  if (orphaned.length === 0) return 0;
  for (const b of orphaned) await env.blobs.delete(`${b.projectId}/${b.key}`);
  await env.db.batch(orphaned.map((b) => env.db
    .prepare(`DELETE FROM blobs WHERE project_id = ? AND key = ?`).bind(b.projectId, b.key)));
  return orphaned.length;
}
