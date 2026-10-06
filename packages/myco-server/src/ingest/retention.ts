import { archiveRawSources } from '../core/raw-archive.js';
import { measuredContentEnv, remainingContentBudget } from '../core/content-budget.js';
/**
 * Raw retention archives eligible event bodies and parsed transcript segments
 * before clearing hot rows. The orphan sweep releases aged objects only after
 * the shared reference catalogue proves that no surviving row names them.
 */
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { unreferencedAmong } from '../core/blob-references.js';
import { releaseBlobs } from '../core/object-release.js';
import { storedSettings } from '../core/settings.js';
import { BLOB_RESERVATION_TTL_MS } from '../constants.js';
import { emit } from '../telemetry.js';

/** The widest retention window a Deployment may set, in days. */
export const TRANSCRIPT_RETENTION_MAX_DAYS = 3650;

/** Parses the legacy transcript window; an absent or zero value means its explicit indefinite choice. */
export function transcriptRetentionDays(raw: string | undefined): number | null | 'unreadable' {
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 'unreadable'; }
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > TRANSCRIPT_RETENTION_MAX_DAYS) return 'unreadable';
  return parsed === 0 ? null : parsed;
}

/** The legacy raw age leaf. */
export const TRANSCRIPT_RETENTION_LEAF = 'retention.transcripts';

/**
 * The effective raw age policy: a canonical leaf wins, a finite legacy leaf is
 * honored, and an explicit legacy zero holds archival. Without either leaf,
 * the 90-day default applies. Unreadable settings hold archival visibly.
 */
export type RetentionFact =
  | { state: 'forever'; configured: boolean; compatibility: 'legacy-hold' }
  | { state: 'days'; days: number; configured: boolean; compatibility: 'canonical'|'legacy-finite'|'default' }
  | { state: 'unavailable'; reason: string };

export const RAW_RETENTION_LEAF = 'retention.raw_days';
export const RAW_RETENTION_DEFAULT_DAYS = 90;

/** Canonical raw age policy; an explicit legacy forever choice holds archival until a finite choice is made. */
export async function transcriptRetentionFact(db: RelationalStore): Promise<RetentionFact> {
  const held = await storedSettings(db, [RAW_RETENTION_LEAF, TRANSCRIPT_RETENTION_LEAF]);
  const canonical = held.get(RAW_RETENTION_LEAF);
  if (canonical !== undefined) return canonical.violation === null
    ? { state:'days',days:canonical.value as number,configured:true,compatibility:'canonical' }
    : { state:'unavailable',reason:'The raw retention window does not read; archival is held.' };
  const legacy = held.get(TRANSCRIPT_RETENTION_LEAF);
  if (legacy === undefined) return { state:'days',days:RAW_RETENTION_DEFAULT_DAYS,configured:false,compatibility:'default' };
  if (legacy.violation !== null) return { state:'unavailable',reason:'The legacy raw window does not read; archival is held.' };
  return legacy.value === 0 ? { state:'forever',configured:true,compatibility:'legacy-hold' }
    : { state:'days',days:legacy.value as number,configured:true,compatibility:'legacy-finite' };
}

/** Maximum blob identities examined in one orphan sweep page. */
export const TRANSCRIPT_RETENTION_BLOBS_PER_PASS = 8;

/**
 * Runs one bounded orphan page and one bounded raw archive page under the
 * effective age policy. Derived rows and unread transcript bytes remain held.
 */
export async function transcriptRetention(env: ServerEnv, now: number): Promise<number> {
  const measured = measuredContentEnv(env, remainingContentBudget(env.db));
  const orphans = await freeOrphanedBlobs(measured.env,now);
  const fact = await transcriptRetentionFact(measured.env.db);
  if(fact.state==='unavailable') { emit({kind:'transcript_retention_refused',reason:'refused'});return orphans; }
  if(fact.state==='forever') return orphans;
  return orphans + await archiveRawSources(measured.env,now,fact.days);
}

/**
 * Blobs no row anywhere references, examined a bounded identity page at a time through the release owner.
 *
 * A session's deletion releases what it can and leaves the rest, and the rows that named those blobs are gone with it
 * — so nothing but this walks them. The committed cursor wraps after the tail, including when every row in a page is
 * held. Newly registered bytes remain available through the upload reservation window.
 */
export async function freeOrphanedBlobs(env: Pick<ServerEnv, 'db'>, now: number): Promise<number> {
  const state = await env.db.prepare(`SELECT cursor_project, cursor_key, revision FROM orphan_sweep_state WHERE id = 1`)
    .first<{ cursor_project: string; cursor_key: string; revision: number }>();
  if (state === null) throw new Error('orphan sweep cursor is missing');
  const { results } = await env.db
    .prepare(`SELECT project_id, key, received_at FROM blobs
               WHERE (project_id, key) > (?, ?)
               ORDER BY project_id, key LIMIT ?`)
    .bind(state.cursor_project, state.cursor_key, TRANSCRIPT_RETENTION_BLOBS_PER_PASS)
    .all<{ project_id: string; key: string; received_at: number }>();
  const aged = results.filter((row) => row.received_at <= now - BLOB_RESERVATION_TTL_MS);
  const unreferenced = await unreferencedAmong(env.db, aged.map((row) => ({ projectId: row.project_id, key: row.key })));
  const outcome = await releaseBlobs(env.db, unreferenced, now);
  const last = results.at(-1);
  if (last !== undefined || state.cursor_project !== '' || state.cursor_key !== '') {
    const committed = await env.db.prepare(`UPDATE orphan_sweep_state SET cursor_project = ?, cursor_key = ?, revision = revision + 1
      WHERE id = 1 AND cursor_project = ? AND cursor_key = ? AND revision = ?`)
      .bind(last?.project_id ?? '', last?.key ?? '', state.cursor_project, state.cursor_key, state.revision).run();
    if (committed.meta.changes !== 1) throw new Error('orphan sweep cursor changed during pass');
  }
  emit({ kind: 'orphaned_blobs_freed', blobs: outcome.released, deferred: outcome.deferred });
  return outcome.released;
}
