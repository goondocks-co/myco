import { writeGuardStore } from './write-guard-store.js';
import { inheritStoreContext } from './adapters.js';
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { DERIVED_TABLES, tombstonedAmong } from './tombstones.js';
import { referencedBlobsOf, unregisteredAmong } from './object-release.js';
import { runsPresentAmong, runsWithoutInstruction } from '../db/runs/body-restore.js';
import { RUN_CHILD_TABLES } from '../db/runs/retention.js';
import type { BlobRef } from './blob-references.js';

type Row = Record<string, unknown>;
const identity = (project: unknown, id: unknown) => JSON.stringify([project, id]);

export interface RetiredRunExclusion { excluded: number; unrecoverable: number }

/**
 * Excludes what retention removed from this Deployment's own backup. A moved body whose bytes are no longer registered
 * cannot be restored: a run absent here leaves the artifact with all its evidence; a run still here loses the reference
 * and any report that needs it. A run here left with no instruction body at all is `unrecoverable`, so the caller refuses
 * rather than restoring an empty body. Another Deployment's backup proves nothing about retention and is left to refuse.
 */
export async function excludeRetiredRuns(db: RelationalStore, tables: Map<string, Row[]>, foreign: boolean): Promise<RetiredRunExclusion> {
  if (foreign) return { excluded: 0, unrecoverable: 0 };
  const bodies = (tables.get('run_bodies') ?? []).filter(row => typeof row.project_id === 'string' && typeof row.key === 'string' && typeof row.run_id === 'string');
  const gone = new Set((await unregisteredAmong(db, bodies.map(row => ({ projectId: row.project_id as string, key: row.key as string })))).map(ref => identity(ref.projectId, ref.key)));
  const lost = bodies.filter(row => gone.has(identity(row.project_id, row.key)));
  if (lost.length === 0) return { excluded: 0, unrecoverable: 0 };
  const runsByProject = new Map<string, Set<string>>();
  for (const row of lost) runsByProject.set(row.project_id as string, (runsByProject.get(row.project_id as string) ?? new Set()).add(row.run_id as string));
  const retired = new Set<string>();
  let unrecoverable = 0;
  for (const [project, runs] of runsByProject) {
    const held = await runsPresentAmong(db, project, [...runs]);
    for (const run of runs) if (!held.has(run)) retired.add(identity(project, run));
    unrecoverable += await runsWithoutInstruction(db, project, lost
      .filter(row => row.project_id === project && row.body_kind === 'instruction' && held.has(row.run_id as string)).map(row => row.run_id as string));
  }
  const lostRefs = new Set(lost);
  const lostReports = new Set(lost.filter(row => row.body_kind !== 'instruction').map(row => JSON.stringify([row.project_id, row.run_id, row.item_id])));
  tables.set('run_bodies', (tables.get('run_bodies') ?? []).filter(row => !lostRefs.has(row) && !retired.has(identity(row.project_id, row.run_id))));
  tables.set('agent_runs', (tables.get('agent_runs') ?? []).filter(row => !retired.has(identity(row.project_id, row.id))));
  for (const table of RUN_CHILD_TABLES) if (tables.has(table)) tables.set(table, tables.get(table)!.filter(row => !retired.has(identity(row.project_id, row.run_id))));
  if (tables.has('agent_reports')) tables.set('agent_reports', tables.get('agent_reports')!.filter(row => !lostReports.has(JSON.stringify([row.project_id, row.run_id, row.id]))));
  return { excluded: retired.size, unrecoverable };
}

/** Excludes deleted session content before object closure and document planning. */
export async function excludeDeletedRestoreRows(db: RelationalStore, tables: Map<string, Row[]>): Promise<RelationalStore> {
  const guarded = await restoreDeletionGuard(db);
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
    ...['prompt_batches','session_prompts'].flatMap(table => (tables.get(table) ?? []).filter(deletedContent).map(row => identity(row.project_id, row.prompt_id))),
  ]);
  const deletedReceipts = new Set((tables.get('spore_injections') ?? []).filter(deletedContent).map(row => identity(row.project_id,row.id)));
  const removedTables = new Set<string>([...DERIVED_TABLES, 'run_reads', 'run_served_material',
    'prompt_batches', 'responses', 'tool_calls', 'fact_classes', 'prompt_key_owners']);
  for (const [table, rows] of tables) {
    if (table === 'session_tombstones') continue;
    tables.set(table, rows.filter(row => {
      const removed = deletedContent(row);
      if (table === 'prepared_archive_bundles' && deletedKeys.has(identity(row.project_id, row.archive_key))) return false;
      if (table === 'tags' && row.entity_kind === 'plan' && deletedPlans.has(identity(row.project_id, row.entity_id))) return false;
      if (table === 'processed_resources' && deletedEvents.has(identity(row.project_id, row.event_id))) return false;
      if (table === 'storage_cleanup_omissions' && row.resource_kind === 'event' && deletedEvents.has(identity(row.project_id,row.resource_id))) return false;
      if (table === 'injection_served_items') {
        if (deletedReceipts.has(identity(row.project_id,row.receipt_id))) return false;
        if (removed) Object.assign(row,{ title:null, content_hash:null, session_id:null, unavailable:1 });
      }
      if (table === 'spores' && deletedPrompts.has(identity(row.project_id, row.prompt_id))) row.prompt_id = null;
      if (table === 'sessions') {
        if (removed) for (const column of ['title','summary','titled_at','titled_by','parent_session_id','parent_reason','launch_parent_session_id']) row[column] = null;
        return true;
      }
      if ((removedTables.has(table) && removed) || deletedTranscripts.has(identity(row.project_id, row.transcript_id))) return false;
      if (table === 'raw_resources') {
        if (row.kind === 'transcript' && deletedTranscripts.has(identity(row.project_id, row.resource_id))) return false;
        if (row.kind === 'event' && deletedEvents.has(identity(row.project_id, row.resource_id))) return false;
      }
      return true;
    }));
  }
  const required = new Set([...tables].flatMap(([table, rows]) => table === 'blobs' ? [] : rows.flatMap(row => restoreBlobReferences(table, row)))
    .map(pair => identity(pair.projectId, pair.key)));
  for (const table of ['prompt_batches','responses','tool_calls']) for (const row of tables.get(table) ?? []) {
    for (const column of ['blob_key','input_blob_key','output_blob_key']) if (typeof row[column] === 'string') required.add(identity(row.project_id,row[column]));
  }
  tables.set('blobs', (tables.get('blobs') ?? []).filter(row => required.has(identity(row.project_id, row.key))));
  return guarded;
}

/** Every write compares the append-only tombstone frontier; its own inserts advance that frontier in the same transaction. */
async function restoreDeletionGuard(source: RelationalStore): Promise<RelationalStore> {
  const frontier = () => source.prepare('SELECT COALESCE(MAX(rowid),0) watermark FROM session_tombstones');
  let watermark = (await frontier().first<{ watermark: number }>())!.watermark;
  const assertions = new WeakSet<PreparedStatement>();
  const checkpointed: RelationalStore = inheritStoreContext(source, {
    prepare: sql => source.prepare(sql),
    async batch(statements) {
      if (!assertions.has(statements[0]!)) return source.batch(statements);
      const results = await source.batch([...statements,frontier()]);
      watermark = (results.at(-1)!.results[0] as { watermark: number }).watermark;
      return results.slice(0,-1);
    },
  });
  return writeGuardStore(checkpointed, () => {
    const assertion = source.prepare(`INSERT INTO restore_reference_guard(missing)
      SELECT 'session deleted during restore' WHERE (SELECT COALESCE(MAX(rowid),0) FROM session_tombstones)<>?`).bind(watermark);
    assertions.add(assertion);
    return assertion;
  }, error => { throw error; });
}

/** Includes immutable document directories and prepared archive bytes in restore's object closure. */
export function restoreBlobReferences(table: string, row: Readonly<Row>): BlobRef[] {
  const columns: Readonly<Record<string, readonly string[]>> = {
    session_chunks: ['blob_key'], prepared_archive_bundles: ['archive_key'],
  };
  return [...referencedBlobsOf(table, row, 'required'), ...(columns[table] ?? []).flatMap(column =>
    typeof row.project_id === 'string' && typeof row[column] === 'string' ? [{ projectId: row.project_id, key: row[column] as string }] : [])];
}
