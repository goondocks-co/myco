import { writeGuardStore } from './write-guard-store.js';
import type { RelationalStore } from './adapters.js';
import { tombstonedAmong } from './tombstones.js';
import { referencedBlobsOf } from './object-release.js';
import type { BlobRef } from './blob-references.js';

type Row = Record<string, unknown>;
const identity = (project: unknown, id: unknown) => JSON.stringify([project, id]);

/** Excludes deleted session content before object closure and document planning. */
export async function excludeDeletedRestoreRows(db: RelationalStore, tables: Map<string, Row[]>): Promise<RelationalStore> {
  const sessions = new Map<string, Set<string>>();
  for (const rows of tables.values()) for (const row of rows) {
    if (typeof row.project_id === 'string' && typeof row.session_id === 'string') {
      sessions.set(row.project_id, (sessions.get(row.project_id) ?? new Set()).add(row.session_id));
    }
  }
  const deleted = new Set((tables.get('session_tombstones') ?? []).map(row => identity(row.project_id, row.session_id)));
  for (const [project, ids] of sessions) for (const id of await tombstonedAmong(db, project, [...ids])) deleted.add(identity(project, id));
  const deletedTranscripts = new Set((tables.get('transcripts') ?? []).filter(row => deleted.has(identity(row.project_id, row.session_id)))
    .map(row => identity(row.project_id, row.transcript_id)));
  const deletedEvents = new Set((tables.get('events') ?? []).filter(row => deleted.has(identity(row.project_id, row.session_id)))
    .map(row => identity(row.project_id, row.event_id)));
  const deletedContent = (row: Row) => deleted.has(identity(row.project_id, row.session_id));
  const deletedKeys = new Set((tables.get('registered_content_proofs') ?? []).filter(deletedContent).map(row => identity(row.project_id, row.key)));
  const deletedPlans = new Set((tables.get('plans') ?? []).filter(deletedContent).map(row => identity(row.project_id, row.plan_key)));
  const deletedPrompts = new Set([
    ...(tables.get('event_refs') ?? []).filter(row => deletedContent(row) && row.kind === 'prompt').map(row => identity(row.project_id, row.record_id)),
    ...(tables.get('prompt_batches') ?? []).filter(deletedContent).map(row => identity(row.project_id, row.prompt_id)),
  ]);
  for (const [table, rows] of tables) {
    if (table === 'session_tombstones') continue;
    tables.set(table, rows.filter(row => {
      const removed = deletedContent(row);
      if (table === 'prepared_archive_bundles' && deletedKeys.has(identity(row.project_id, row.archive_key))) return false;
      if (table === 'tags' && row.entity_kind === 'plan' && deletedPlans.has(identity(row.project_id, row.entity_id))) return false;
      if (table === 'processed_resources' && deletedEvents.has(identity(row.project_id, row.event_id))) return false;
      if (table === 'spores' && deletedPrompts.has(identity(row.project_id, row.prompt_id))) row.prompt_id = null;
      if (table === 'sessions') {
        if (removed) for (const column of ['title','summary','titled_at','titled_by','parent_session_id','parent_reason','launch_parent_session_id']) row[column] = null;
        return true;
      }
      if (removed || deletedTranscripts.has(identity(row.project_id, row.transcript_id))) return false;
      if (table === 'raw_resources') {
        if (row.kind === 'transcript' && deletedTranscripts.has(identity(row.project_id, row.resource_id))) return false;
        if (row.kind === 'event' && deletedEvents.has(identity(row.project_id, row.resource_id))) return false;
      }
      return true;
    }));
  }
  const required = new Set([...tables].flatMap(([table, rows]) => table === 'blobs' ? [] : rows.flatMap(row => restoreBlobReferences(table, row)))
    .map(pair => identity(pair.projectId, pair.key)));
  tables.set('blobs', (tables.get('blobs') ?? []).filter(row => required.has(identity(row.project_id, row.key))));
  const active = [...sessions].flatMap(([project, ids]) => [...ids].filter(id => !deleted.has(identity(project, id))).map(id => ({ project, id })));
  const guardPage = 256;
  for (let at = 0; at < active.length; at += guardPage) {
    const underlying = db;
    const page = JSON.stringify(active.slice(at, at + guardPage));
    db = writeGuardStore(underlying, () => underlying.prepare(`INSERT INTO restore_reference_guard(missing)
      SELECT 'session deleted during restore' WHERE EXISTS (SELECT 1 FROM json_each(?) j JOIN session_tombstones t
        ON t.project_id=json_extract(j.value,'$.project') AND t.session_id=json_extract(j.value,'$.id'))`).bind(page), error => { throw error; });
  }
  return db;
}

/** Includes input-only legacy content and immutable document directories in restore's object closure. */
export function restoreBlobReferences(table: string, row: Readonly<Row>): BlobRef[] {
  const columns: Readonly<Record<string, readonly string[]>> = {
    prompt_batches: ['blob_key'], responses: ['blob_key'], tool_calls: ['input_blob_key','output_blob_key'],
    session_chunks: ['blob_key'], prepared_archive_bundles: ['archive_key'],
  };
  return [...referencedBlobsOf(table, row), ...(columns[table] ?? []).flatMap(column =>
    typeof row.project_id === 'string' && typeof row[column] === 'string' ? [{ projectId: row.project_id, key: row[column] as string }] : [])];
}
