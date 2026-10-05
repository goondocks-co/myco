import type { JobBudget, RelationalStore } from './adapters.js';
import { PROCESSED_FIELDS, processedReferenceSql } from './processed-resources.js';
import { rawCredentialOwner, rawCredentialProvenance, rawTranscriptOwner, rawTranscriptProvenance, rawTranscriptClaimMember } from './raw-provenance.js';

export const RAW_BACKFILL_BATCH = 500;
export const RAW_BACKFILL_BUDGET: Readonly<JobBudget> = { calls: 120, wallMs: 2_000 };
/** Two reads and at most four statements in the atomic page commit. */
const PAGE_CALLS = 6;
const RAW_SOURCES = [
  { table: 'blobs', id: 'key', kind: 'blob' },
  { table: 'transcripts', id: 'transcript_id', kind: 'transcript' },
  { table: 'events', id: 'event_id', kind: 'event' },
] as const;
const SOURCES = [...RAW_SOURCES, ...Object.entries(PROCESSED_FIELDS).map(([kind, field]) => ({ ...field, kind }))];

/** One bounded source page and its checkpoint commit together; retries retain the first attribution. */
async function rawBackfillPage(db: RelationalStore, now: number): Promise<{ changed: number; more: boolean }> {
  const state = await db.prepare('SELECT source, cursor_project, cursor_id, complete FROM raw_provenance_backfill WHERE id = 1')
    .first<{ source: number; cursor_project: string; cursor_id: string; complete: number }>();
  if (state === null || state.complete === 1) return { changed: 0, more: false };
  const source = SOURCES[state.source];
  if (source === undefined) throw new Error('Unknown raw provenance backfill source');
  const predicate = `(s.project_id, s.${source.id}) > (?, ?)`;
  const args = [state.cursor_project, state.cursor_id, RAW_BACKFILL_BATCH];
  const rows = (await db.prepare(`SELECT s.project_id, s.${source.id} AS resource_id FROM ${source.table} s
    WHERE ${predicate} ORDER BY s.project_id, s.${source.id} LIMIT ?`).bind(...args).all<{ project_id: string; resource_id: string }>()).results;
  const held = `EXISTS (SELECT 1 FROM raw_provenance_backfill WHERE id = 1 AND source = ? AND cursor_project = ? AND cursor_id = ? AND complete = 0)`;
  const guard = [state.source, state.cursor_project, state.cursor_id];
  const page = `(SELECT s.* FROM ${source.table} s JOIN json_each(?) selected
    ON s.project_id = json_extract(selected.value, '$.project_id') AND s.${source.id} = json_extract(selected.value, '$.resource_id'))`;
  const selected = JSON.stringify(rows);
  let insert: string;
  if (source.kind === 'event') {
    insert = `INSERT INTO raw_credentials (token_id, owner_member_id, provenance)
      SELECT DISTINCT s.token_id, ${rawCredentialOwner('s.token_id')}, ${rawCredentialProvenance('s.token_id')}
        FROM ${page} s WHERE ${held} ON CONFLICT DO NOTHING`;
  } else if (source.kind === 'blob' || source.kind === 'transcript') {
    const blob = source.kind === 'blob';
    insert = `INSERT INTO raw_resources (project_id,kind,resource_id,reference_id,owner_member_id,machine_id,token_id,provenance,revision,claim_member_id)
      SELECT s.project_id, '${source.kind}', s.${source.id}, ${blob ? 's.token_id' : "''"},
        ${blob ? rawCredentialOwner('s.token_id') : rawTranscriptOwner('s')},
        ${blob ? '(SELECT machine_id FROM member_credentials WHERE id = s.token_id)' : 's.machine_id'}, s.token_id,
        ${blob ? rawCredentialProvenance('s.token_id') : rawTranscriptProvenance('s')}, (SELECT revision + 1 FROM raw_provenance_state WHERE id = 1), ${blob ? 'NULL' : rawTranscriptClaimMember('s')}
        FROM ${page} s WHERE ${held} ON CONFLICT DO NOTHING`;
  } else {
    if (!('blob' in source)) throw new Error('Missing processed field backfill');
    insert = `INSERT INTO processed_resources (project_id,kind,resource_id,blob_key,source_token_id,event_id)
      SELECT s.project_id, '${source.kind}', s.${source.id}, s.${source.blob}, s.token_id, s.event_id
        FROM ${page} s WHERE s.${source.blob} IS NOT NULL AND ${processedReferenceSql('s', source)} AND ${held} ON CONFLICT DO NOTHING`;
  }
  const last = rows.at(-1);
  const finishedSource = rows.length < RAW_BACKFILL_BATCH;
  const nextSource = finishedSource ? state.source + 1 : state.source;
  const results = await db.batch([
    db.prepare(`${insert} RETURNING 1 AS inserted`).bind(selected, ...guard),
    ...(source.kind === 'event' ? [
      db.prepare(`UPDATE raw_provenance_state SET revision = revision + 1 WHERE id = 1 AND ${held} AND json_array_length(?) > 0`).bind(...guard, selected),
      db.prepare(`UPDATE events SET raw_revision = (SELECT revision FROM raw_provenance_state WHERE id = 1) WHERE raw_revision IS NULL AND (project_id, event_id) IN
      (SELECT s.project_id,s.event_id FROM ${page} s) AND ${held}`).bind(selected, ...guard)] : []),
    db.prepare(`UPDATE raw_provenance_backfill SET source = ?, cursor_project = ?, cursor_id = ?, complete = ?, updated_at = ?
      WHERE id = 1 AND source = ? AND cursor_project = ? AND cursor_id = ? AND complete = 0`)
      .bind(nextSource, finishedSource ? '' : last!.project_id, finishedSource ? '' : last!.resource_id,
        nextSource === SOURCES.length ? 1 : 0, now, ...guard),
  ]);
  return { changed: results[0]!.results.length, more: nextSource < SOURCES.length };
}

/** Drains independently committed pages within a statement and elapsed-time allowance. */
export async function rawBackfill(
  db: RelationalStore,
  now: number,
  { budget = RAW_BACKFILL_BUDGET, clock = Date.now }: { budget?: Readonly<JobBudget>; clock?: () => number } = {},
): Promise<{ changed: number; more: boolean }> {
  const deadline = clock() + budget.wallMs;
  let changed = 0;
  let more = true;
  let longestPageMs = 0;
  for (let calls = 0; more && calls + PAGE_CALLS <= budget.calls; calls += PAGE_CALLS) {
    const start = clock();
    if (start + longestPageMs >= deadline) break;
    const page = await rawBackfillPage(db, now);
    changed += page.changed;
    more = page.more;
    longestPageMs = Math.max(longestPageMs, clock() - start);
  }
  return { changed, more };
}

export async function rawBackfillPending(db: RelationalStore): Promise<boolean> {
  return (await db.prepare('SELECT complete FROM raw_provenance_backfill WHERE id = 1').first<{ complete: number }>())?.complete === 0;
}
