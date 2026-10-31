/**
 * Restore of a backup artifact's legacy content rows into session documents. A class flag never discards content:
 *
 * - **Convert.** A session the target holds no live document for has every artifact content row converted, whatever
 *   its class: before the first write, one batch checks it is still not live and that no other restore holds it,
 *   discards what its conversion built so far and holds it from conversion under this restore's identity; once the rows
 *   are restored this restore releases its own hold, and conversion exports them with the rest into its first
 *   generation. A session that went live after the plan, or that another restore holds, refuses the restore before any write.
 * - **Merge.** A session with a live document keeps every record it holds; an artifact row whose id it lacks is added
 *   to the live generation, unless the artifact classifies that row as the legacy derivation.
 * - **Refuse.** Such a legacy-classified row may hold content the document keeps under another id, so precedence is
 *   ambiguous and the whole restore is refused before any write.
 */
import type { PreparedStatement, ServerEnv } from '../core/adapters.js';
import { contentAssertion } from '../core/registered-content.js';
import { SessionDocument } from '../content/session-pages.js';
import type { ChunkRow, PageRow } from '../content/document-reader.js';
import { DocumentBatch, directoryStatements, type BatchDocument } from './document-batch.js';
import { legacyRecord } from './document-conversion.js';
import type { RestoreDocuments } from '../core/backup.js';

/** The legacy content tables a restore converts, in the order their records are placed: prompts before what names them. */
const CONTENT = [
  { table: 'prompt_batches', kind: 'prompt', id: 'prompt_id' },
  { table: 'responses', kind: 'reply', id: 'response_id' },
  { table: 'tool_calls', kind: 'tool', id: 'tool_call_id' },
] as const;
type ContentKind = (typeof CONTENT)[number]['kind'];
type Row = Record<string, unknown>;

export interface SessionRef { projectId: string; sessionId: string }
type HeldRows = SessionRef & { rows: { kind: ContentKind; row: Row }[] };
export interface DocumentRestorePlan {
  convert: SessionRef[];
  merge: HeldRows[];
  refuse: SessionRef[];
}
/** How long a restore holds the sessions it converts from conversion while it writes their rows. */
export const RESTORE_CONVERSION_HOLD_MS = 15 * 60_000;
const PLAN_STALE = 'restore_plan_stale';
const PLAN_STALE_PATH = `$[${PLAN_STALE}]`;
export class RestorePlanStale extends Error {
  constructor() { super(`${PLAN_STALE}: a session this restore converts went live after the restore was planned; restore the artifact again`); }
}
const IN_PROGRESS = 'restore_in_progress';
const IN_PROGRESS_PATH = `$[${IN_PROGRESS}]`;
export class RestoreInProgress extends Error {
  constructor() { super(`${IN_PROGRESS}: another restore holds a session this restore converts; restore the artifact again once it finishes`); }
}
export class ArtifactPrecedenceAmbiguous extends Error {
  constructor(readonly sessions: readonly SessionRef[]) {
    super(`artifact_precedence_ambiguous: ${sessions.map((s) => s.sessionId).join(', ')}; restore these sessions through the staged restore`);
  }
}

/** Every record id a live document holds, as `kind:id`, read chunk by chunk. */
async function documentIds(env: Pick<ServerEnv, 'db' | 'blobs'>, ref: SessionRef): Promise<Set<string> | null> {
  const doc = await SessionDocument.open(env, ref.projectId, ref.sessionId);
  if (doc === null) return null;
  const ids = new Set<string>();
  for (let after = -1; ;) {
    const read = await doc.chunksAfter(after, 8);
    for (const chunk of read.chunks) for (const page of chunk.pages) for (const record of page.records) ids.add(`${record.k}:${record.id}`);
    if (!read.more || read.chunks.length === 0) return ids;
    after = read.chunks.at(-1)!.chunkNo;
  }
}

/** Decides each session the artifact holds content for, reading the target before anything is written. */
export async function planDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, byTable: ReadonlyMap<string, readonly Row[]>): Promise<DocumentRestorePlan> {
  const legacy = new Set((byTable.get('fact_classes') ?? []).filter((row) => row.class === 'legacy')
    .map((row) => JSON.stringify([row.project_id, row.table_name, row.record_id])));
  const sessions = new Map<string, SessionRef & { rows: { kind: ContentKind; table: string; id: string; row: Row }[] }>();
  for (const { table, kind, id } of CONTENT) for (const row of byTable.get(table) ?? []) {
    if (typeof row.project_id !== 'string' || typeof row.session_id !== 'string') continue;
    const key = JSON.stringify([row.project_id, row.session_id]);
    const held = sessions.get(key) ?? { projectId: row.project_id, sessionId: row.session_id, rows: [] };
    held.rows.push({ kind, table, id: String(row[id]), row });
    sessions.set(key, held);
  }
  const plan: DocumentRestorePlan = { convert: [], merge: [], refuse: [] };
  for (const session of sessions.values()) {
    const ref = { projectId: session.projectId, sessionId: session.sessionId };
    const present = await documentIds(env, ref);
    if (present === null) { plan.convert.push(ref); continue; }
    const absent = session.rows.filter((held) => !present.has(`${held.kind}:${held.id}`));
    if (absent.some((held) => legacy.has(JSON.stringify([ref.projectId, held.table, held.id])))) plan.refuse.push(ref);
    else if (absent.length > 0) plan.merge.push({ ...ref, rows: absent.map(({ kind, row }) => ({ kind, row })) });
  }
  return plan;
}

/** The catalog tables a conversion fills before its flip. */
const BUILT = ['session_chunks', 'session_pages', 'session_prompts', 'session_paths', 'myco_tool_calls', 'transcript_publication'] as const;

/**
 * Restarts the conversion of every session the plan converts that `holder` may hold, in one batch that first refuses
 * when any of them is live or held by another restore whose hold has not run out. The chunks its conversion built are
 * held for release and its catalog rows and counters cleared. Fencing (`heldUntil` set) takes the hold for `holder`,
 * before which conversion passes the session by; applying (`heldUntil` null) restarts and releases only the sessions
 * `holder` holds.
 */
async function restartConversions(db: Pick<ServerEnv, 'db'>['db'], plan: DocumentRestorePlan, holder: string, now: number,
  heldUntil: number | null): Promise<void> {
  if (plan.convert.length === 0) return;
  const refs = JSON.stringify(plan.convert.map(({ projectId, sessionId }) => ({ projectId, sessionId })));
  const planned = `json_each(?) j JOIN session_documents d ON d.project_id = json_extract(j.value,'$.projectId') AND d.session_id = json_extract(j.value,'$.sessionId')`;
  const mine = heldUntil === null ? 'AND d.restore_hold = ?' : '';
  const own = heldUntil === null ? [holder] : [];
  const converting = `(project_id, session_id) IN (SELECT d.project_id, d.session_id FROM ${planned} AND d.state = 'convert' ${mine})`;
  try {
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ${planned} AND d.state = 'live') THEN json_extract('[]', ?)
          WHEN EXISTS (SELECT 1 FROM ${planned} AND d.restore_hold IS NOT NULL AND d.restore_hold <> ? AND d.due_at > ?) THEN json_extract('[]', ?)
          ELSE 1 END AS admitted`)
        .bind(refs, PLAN_STALE_PATH, refs, holder, now, IN_PROGRESS_PATH),
      db.prepare(`INSERT OR IGNORE INTO retired_objects (project_id, session_id, blob_key, source_id, retired_at)
        SELECT project_id, session_id, blob_key, source_id, ? FROM session_chunks WHERE ${converting}`).bind(now, refs, ...own),
      ...BUILT.map((table) => db.prepare(`DELETE FROM ${table} WHERE ${converting}`).bind(refs, ...own)),
      heldUntil === null
        ? db.prepare(`UPDATE session_documents SET generation = NULL, build = NULL, due_at = NULL, restore_hold = NULL,
            prompts = 0, user_prompts = 0, replies = 0, tool_calls = 0, failed_tools = 0, plans = 0, first_prompt = NULL,
            last_record_at = NULL, open_turn_key = NULL, next_chunk = 0, updated_at = ? WHERE ${converting}`).bind(now, refs, holder)
        : db.prepare(`INSERT INTO session_documents (project_id, session_id, state, due_at, restore_hold, updated_at)
            SELECT json_extract(value,'$.projectId'), json_extract(value,'$.sessionId'), 'convert', ?, ?, ? FROM json_each(?) WHERE true
            ON CONFLICT (project_id, session_id) DO UPDATE SET state = 'convert', generation = NULL, build = NULL, due_at = excluded.due_at,
              restore_hold = excluded.restore_hold, prompts = 0, user_prompts = 0, replies = 0, tool_calls = 0, failed_tools = 0, plans = 0,
              first_prompt = NULL, last_record_at = NULL, open_turn_key = NULL, next_chunk = 0, updated_at = excluded.updated_at
              WHERE session_documents.state = 'convert'`).bind(heldUntil, holder, now, refs),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes(PLAN_STALE_PATH.slice(1))) throw new RestorePlanStale();
    if (error instanceof Error && error.message.includes(IN_PROGRESS_PATH.slice(1))) throw new RestoreInProgress();
    throw error;
  }
}

/** Before the restore's first write: re-checks the sessions it converts and holds them from conversion for `holder`. */
export async function fenceDocumentRestore(env: Pick<ServerEnv, 'db'>, plan: DocumentRestorePlan, holder: string, now: number): Promise<void> {
  await restartConversions(env.db, plan, holder, now, now + RESTORE_CONVERSION_HOLD_MS);
}

/**
 * Applies a plan once the artifact's rows are restored: each converting session `holder` holds restarts its conversion
 * again, so nothing a held pass adopted stands behind the restored rows, and its hold is released; merged rows join
 * their live document.
 */
export async function applyDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, plan: DocumentRestorePlan, holder: string, now: number): Promise<void> {
  await restartConversions(env.db, plan, holder, now, null);
  for (const session of plan.merge) await mergeSession(env, session, now);
}

async function mergeSession(env: Pick<ServerEnv, 'db' | 'blobs'>, session: HeldRows, now: number): Promise<void> {
  const db = env.db;
  const [docs, chunks, pages] = await db.batch([
    db.prepare(`SELECT d.generation, d.next_chunk, d.prompts, d.first_prompt, d.open_turn_key, s.created_by_token_id token_id
      FROM session_documents d JOIN sessions s ON s.project_id = d.project_id AND s.session_id = d.session_id
      WHERE d.project_id = ?1 AND d.session_id = ?2 AND d.state = 'live'`).bind(session.projectId, session.sessionId),
    ...directoryStatements(db, session.projectId, session.sessionId),
  ]);
  const doc = docs!.results[0] as BatchDocument | undefined;
  if (doc === undefined) return;
  const batch = new DocumentBatch(env, session.projectId, session.sessionId, doc, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
  await batch.open();
  const order = new Map(CONTENT.map(({ kind }, index) => [kind, index]));
  const rows = [...session.rows].sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || Number(a.row.created_at) - Number(b.row.created_at));
  const records = [];
  for (const { kind, row } of rows) records.push(await legacyRecord(env, session.projectId, kind, row));
  await batch.place(records, null);
  await batch.commit(batch.writer.changed, 'live', now, (version) => ({
    sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=?)
      AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
    params: [session.projectId, session.sessionId, doc.generation, session.projectId, session.sessionId, version.key, version.sourceId],
  }), (registered) => {
    const set = batch.documentSet(now);
    const before: PreparedStatement[] = contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=?
        AND state='live' AND generation=? AND next_chunk=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=?
        AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))`,
    [session.projectId, session.sessionId, doc.generation, doc.next_chunk, batch.expectedChunks(registered), session.projectId, session.sessionId, doc.generation]);
    return { before, after: [db.prepare(`UPDATE session_documents SET ${set.sql} WHERE project_id=? AND session_id=?`)
      .bind(...set.params, session.projectId, session.sessionId)] };
  });
}

/** The document side of a restore over this environment, as `core/backup.ts` takes it. */
export function restoreDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>): RestoreDocuments {
  return {
    async plan(byTable) {
      const plan = await planDocumentRestore(env, byTable);
      const holder = crypto.randomUUID();
      return {
        summary: { convert: plan.convert.length, merge: plan.merge.length, records: plan.merge.reduce((sum, s) => sum + s.rows.length, 0),
          refuse: plan.refuse.map((s) => s.sessionId) },
        fence: (now) => fenceDocumentRestore(env, plan, holder, now),
        apply: (now) => applyDocumentRestore(env, plan, holder, now),
      };
    },
  };
}
