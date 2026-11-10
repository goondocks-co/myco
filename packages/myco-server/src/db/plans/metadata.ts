import { write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { changed, jsonKeys, trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * What a plan list shows of a plan's body, kept beside the plan so a list never reads the body: a preview of its opening
 * and the progress of its task list. Each plan holds one `plan_metadata` row, re-derived from the plan whenever a
 * trigger or a catch-up page names its key, so every writer of a plan (capture, transcript publication, a status
 * edit, a restore) keeps it in the statement that writes the plan. A key with no row yet is still being derived, which
 * a list reports as unknown progress, never as none.
 */
const PLAN_METADATA_PROJECTION = 'plan_metadata';
const PLAN_METADATA_PHASE = 'planMetadata';

/** How many characters of a plan's opening its preview keeps. */
const PLAN_PREVIEW_CHARS = 240;
/** The body characters a preview is cut from, before whitespace is folded and the preview trimmed. */
const PREVIEW_SOURCE_CHARS = PLAN_PREVIEW_CHARS * 2;

/** A plan's opening with line breaks and tabs read as spaces, or null for a plan whose body is stored apart. */
const previewSql = (p: string) => `CASE WHEN ${p}.content IS NULL THEN NULL ELSE substr(trim(replace(replace(replace(
  substr(${p}.content,1,${PREVIEW_SOURCE_CHARS}),char(13),' '),char(10),' '),char(9),' ')),1,${PLAN_PREVIEW_CHARS}) END`;
/** How many times `marker` occurs in `text`: the length the occurrences take, over the marker's length. */
const occurrences = (text: string, marker: string) => `((length(${text})-length(replace(${text},'${marker}','')))/${marker.length})`;
/** Checked items: `- [x]` in either case. A plan stored apart has no task list here. */
const doneSql = (p: string) => `COALESCE(${occurrences(`lower(${p}.content)`, '- [x]')},0)`;
const openSql = (p: string) => `COALESCE(${occurrences(`${p}.content`, '- [ ]')},0)`;

/** Re-derive the metadata of the plan keys `keys` (columns `project_id,plan_key`): a key whose plan is gone loses its row. */
function reconcilePlanMetadata(keys: string): string[] {
  return [
    `DELETE FROM plan_metadata WHERE (project_id,plan_key) IN (SELECT project_id,plan_key FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.project_id=plan_metadata.project_id AND p.plan_key=plan_metadata.plan_key)`,
    `INSERT INTO plan_metadata(project_id,plan_key,preview,progress_done,progress_total)
      SELECT d.project_id,d.plan_key,d.preview,d.done,d.done+d.open FROM (SELECT p.project_id,p.plan_key,${previewSql('p')} AS preview,
        ${doneSql('p')} AS done,${openSql('p')} AS open FROM (${keys}) key JOIN plans p ON p.project_id=key.project_id AND p.plan_key=key.plan_key) d WHERE 1
      ON CONFLICT(project_id,plan_key) DO UPDATE SET preview=excluded.preview,progress_done=excluded.progress_done,progress_total=excluded.progress_total
        WHERE (plan_metadata.preview,plan_metadata.progress_done,plan_metadata.progress_total) IS NOT (excluded.preview,excluded.progress_done,excluded.progress_total)`,
  ];
}

/** One catch-up page: the keys' metadata re-derived inside the caller's commit. */
export const PLAN_METADATA_CATCHUP = {
  projection: PLAN_METADATA_PROJECTION,
  phases: { [PLAN_METADATA_PHASE]: { source: { table: 'plans', columns: ['project_id', 'plan_key'], unique: true },
    reconcile: reconcilePlanMetadata(jsonKeys(['project_id', 'plan_key'])).map((sql, i) => write<[string]>({ name: `planMetadata.page${i}`, sql })) } },
} as const satisfies CatchupFamily;

/** The derived table, the triggers that keep it on every plan write and the catch-up seed, as one schema step freezes them. */
export function planMetadataSchemaStatements(): string[] {
  const rowKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.plan_key AS plan_key`;
  const watched = ['project_id', 'plan_key', 'content'];
  return [
    `CREATE TABLE IF NOT EXISTS plan_metadata(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),plan_key TEXT NOT NULL,preview TEXT,
      progress_done INTEGER NOT NULL,progress_total INTEGER NOT NULL,PRIMARY KEY(project_id,plan_key)) WITHOUT ROWID`,
    trigger('plan_metadata_insert', 'plans', 'INSERT', reconcilePlanMetadata(rowKey('NEW'))).sql,
    trigger('plan_metadata_update', 'plans', `UPDATE OF ${watched.join(',')}`,
      [...reconcilePlanMetadata(rowKey('OLD')), ...reconcilePlanMetadata(rowKey('NEW'))], changed(watched)).sql,
    trigger('plan_metadata_delete', 'plans', 'DELETE', reconcilePlanMetadata(rowKey('OLD'))).sql,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${PLAN_METADATA_PROJECTION}','${PLAN_METADATA_PHASE}',NOT EXISTS(SELECT 1 FROM plans)`,
  ];
}
