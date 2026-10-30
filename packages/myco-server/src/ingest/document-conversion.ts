/**
 * Conversion: a session present before documents existed becomes generation 1 of its document, exporting what
 * today's readers see.
 *
 * - **Adopt.** One read takes each transcript's effective frontier, continuation and identity policy: the live view's
 *   checkpoint under the view mapping for a published session, else the transcript's own cursor under its pins. The
 *   continuations and harness key owners go into the document's last page chunk; the frontiers wait in the build.
 * - **Export.** The effective rows are paged in a fixed order, prompts first: for a published session the surviving
 *   facts, then the live view's rows no fact shadows, then the frozen parent's rows neither shadows; for any other session, the
 *   legacy rows. Retained prompt, reply, plan and tool input bodies are read back whole; a tool's full output is not.
 *   Every page commits its chunks as `building`, with the build cursor, in one guarded batch.
 * - **Flip.** One batch makes generation 1 live, writes the adopted frontiers for the publisher to resume from, and
 *   leaves the conversion report in `session_documents.build`.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import { contentAssertion, readVerifiedContentText } from '../core/registered-content.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { readBundleEntry } from '../core/archive-bundle.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { emit } from '../telemetry.js';
import { materialRecord } from '../content/document-records.js';
import type { RecordKind } from '../content/document.js';
import type { ChunkRow, PageRow } from '../content/document-reader.js';
import {
  DocumentBatch, directoryStatements, PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, publicationStatement, publishedPromptScheme,
  PUBLISHED_RECORD_SCHEME, reserveReached, type BatchDocument, type ChunkVersion,
} from './document-batch.js';
import { readParserCheckpoint } from './parser-checkpoint.js';
import type { PassLimits } from './parse.js';

/** Rows one export page reads from one source. */
export const CONVERT_ROWS_PER_PAGE = 200;
/** Store and blob calls one export page may spend: its reads, a chunk write with read-back, and the commit. */
const CONVERT_CALLS_PER_PAGE = 8;
const GENERATION = 1;

const MATERIALS = [
  { kind: 'prompt', fact: 'prompt_batches', view: 'view_prompts', id: 'prompt_id', bodies: [['blob_key', 'text']] },
  { kind: 'reply', fact: 'responses', view: 'view_responses', id: 'response_id', bodies: [['blob_key', 'text']] },
  { kind: 'tool', fact: 'tool_calls', view: 'view_tool_calls', id: 'tool_call_id', bodies: [['input_blob_key', 'input']] },
  { kind: 'plan', fact: 'plans', view: 'view_plans', id: 'plan_key', bodies: [['blob_key', 'content']] },
] as const satisfies readonly { kind: RecordKind; fact: string; view: string; id: string; bodies: readonly (readonly [string, string])[] }[];
type Material = (typeof MATERIALS)[number];
type Source = 'fact' | 'live' | 'parent';

/** What conversion found for one session, kept with its live document. */
export interface ConversionReport {
  rows: Record<string, number>;
  records: Record<string, number>;
  /** Order-free digests of the exported row ids and the published record ids, per kind. */
  ids: Record<string, { rows: string; records: string }>;
  bodies: number;
  classes: Record<string, number>;
}

interface Build {
  published: boolean;
  live: string | null;
  parent: string | null;
  step: number;
  after: [number, string] | null;
  adopted: Record<string, unknown>[];
  report: ConversionReport;
}

interface ConvertingRow extends BatchDocument { build: string | null }

const emptyReport = (): ConversionReport => ({
  rows: {}, records: {}, ids: Object.fromEntries(MATERIALS.map((m) => [m.kind, { rows: '0', records: '0' }])), bodies: 0, classes: {},
});
const count = (into: Record<string, number>, key: string, n = 1) => { if (n !== 0) into[key] = (into[key] ?? 0) + n; };

/** Folds ids into an order-free digest: the XOR of each id's first 64 hashed bits. */
async function foldIds(digest: string, kind: string, ids: readonly string[]): Promise<string> {
  let folded = BigInt('0x' + digest);
  for (const id of ids) folded ^= BigInt('0x' + (await sha256Hex(`${kind}:${id}`)).slice(0, 16));
  return folded.toString(16);
}

const steps = (build: Build): [Material, Source][] => MATERIALS.flatMap((material) =>
  (build.published ? ['fact', 'live', ...(build.parent === null ? [] : ['parent'])] as Source[] : ['fact'] as Source[])
    .map((source) => [material, source] as [Material, Source]));

/**
 * One page of each source's effective rows after the keyset `(?3 created_at, ?4 id)`; a view source binds its instance as
 * `?5` and the live instance as `?6`.
 */
const EXPORTS = {
  prompt: {
    legacy: `SELECT r.* FROM prompt_batches r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.prompt_id>?4) ORDER BY r.created_at,r.prompt_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    fact: `SELECT r.* FROM prompt_batches r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.prompt_id>?4)
      AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=r.project_id AND fc.table_name='prompt_batches' AND fc.record_id=r.prompt_id AND fc.class='legacy') ORDER BY r.created_at,r.prompt_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    live: `SELECT r.* FROM view_prompts r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.prompt_id>?4)
      AND NOT EXISTS (SELECT 1 FROM prompt_batches w WHERE w.project_id=r.project_id AND w.prompt_id=r.prompt_id AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='prompt_batches' AND fc.record_id=w.prompt_id AND fc.class='legacy')) ORDER BY r.created_at,r.prompt_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    parent: `SELECT r.* FROM view_prompts r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.prompt_id>?4)
      AND NOT EXISTS (SELECT 1 FROM prompt_batches w WHERE w.project_id=r.project_id AND w.prompt_id=r.prompt_id AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='prompt_batches' AND fc.record_id=w.prompt_id AND fc.class='legacy'))
      AND NOT EXISTS (SELECT 1 FROM view_prompts l WHERE l.project_id=r.project_id AND l.instance_id=?6 AND l.prompt_id=r.prompt_id) ORDER BY r.created_at,r.prompt_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
  },
  reply: {
    legacy: `SELECT r.* FROM responses r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.response_id>?4) ORDER BY r.created_at,r.response_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    fact: `SELECT r.* FROM responses r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.response_id>?4)
      AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=r.project_id AND fc.table_name='responses' AND fc.record_id=r.response_id AND fc.class='legacy') ORDER BY r.created_at,r.response_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    live: `SELECT r.* FROM view_responses r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.response_id>?4)
      AND NOT EXISTS (SELECT 1 FROM responses w WHERE w.project_id=r.project_id AND w.response_id=r.response_id AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='responses' AND fc.record_id=w.response_id AND fc.class='legacy')) ORDER BY r.created_at,r.response_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    parent: `SELECT r.* FROM view_responses r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.response_id>?4)
      AND NOT EXISTS (SELECT 1 FROM responses w WHERE w.project_id=r.project_id AND w.response_id=r.response_id AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='responses' AND fc.record_id=w.response_id AND fc.class='legacy'))
      AND NOT EXISTS (SELECT 1 FROM view_responses l WHERE l.project_id=r.project_id AND l.instance_id=?6 AND l.response_id=r.response_id) ORDER BY r.created_at,r.response_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
  },
  tool: {
    legacy: `SELECT r.* FROM tool_calls r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.tool_call_id>?4) ORDER BY r.created_at,r.tool_call_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    fact: `SELECT r.* FROM tool_calls r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.tool_call_id>?4)
      AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=r.project_id AND fc.table_name='tool_calls' AND fc.record_id=r.tool_call_id AND fc.class='legacy') ORDER BY r.created_at,r.tool_call_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    live: `SELECT r.* FROM view_tool_calls r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.tool_call_id>?4)
      AND NOT EXISTS (SELECT 1 FROM tool_calls w WHERE w.project_id=r.project_id AND w.tool_call_id=r.tool_call_id AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='tool_calls' AND fc.record_id=w.tool_call_id AND fc.class='legacy')) ORDER BY r.created_at,r.tool_call_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    parent: `SELECT r.* FROM view_tool_calls r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.tool_call_id>?4)
      AND NOT EXISTS (SELECT 1 FROM tool_calls w WHERE w.project_id=r.project_id AND w.tool_call_id=r.tool_call_id AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='tool_calls' AND fc.record_id=w.tool_call_id AND fc.class='legacy'))
      AND NOT EXISTS (SELECT 1 FROM view_tool_calls l WHERE l.project_id=r.project_id AND l.instance_id=?6 AND l.tool_call_id=r.tool_call_id) ORDER BY r.created_at,r.tool_call_id LIMIT ${CONVERT_ROWS_PER_PAGE}`,
  },
  plan: {
    legacy: `SELECT r.* FROM plans r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.plan_key>?4) ORDER BY r.created_at,r.plan_key LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    fact: `SELECT r.* FROM plans r WHERE r.project_id=?1 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.plan_key>?4)
      AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=r.project_id AND fc.table_name='plans' AND fc.record_id=r.plan_key AND fc.class='legacy') ORDER BY r.created_at,r.plan_key LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    live: `SELECT r.* FROM view_plans r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.plan_key>?4)
      AND NOT EXISTS (SELECT 1 FROM plans w WHERE w.project_id=r.project_id AND w.plan_key=r.plan_key AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='plans' AND fc.record_id=w.plan_key AND fc.class='legacy')) ORDER BY r.created_at,r.plan_key LIMIT ${CONVERT_ROWS_PER_PAGE}`,
    parent: `SELECT r.* FROM view_plans r WHERE r.project_id=?1 AND r.instance_id=?5 AND r.session_id=?2 AND (r.created_at>?3 OR r.created_at=?3 AND r.plan_key>?4)
      AND NOT EXISTS (SELECT 1 FROM plans w WHERE w.project_id=r.project_id AND w.plan_key=r.plan_key AND NOT EXISTS (SELECT 1 FROM fact_classes fc WHERE fc.project_id=w.project_id AND fc.table_name='plans' AND fc.record_id=w.plan_key AND fc.class='legacy'))
      AND NOT EXISTS (SELECT 1 FROM view_plans l WHERE l.project_id=r.project_id AND l.instance_id=?6 AND l.plan_key=r.plan_key) ORDER BY r.created_at,r.plan_key LIMIT ${CONVERT_ROWS_PER_PAGE}`,
  },
} as const;

/** A continuation as the publisher resumes it: a chunked parser state is read back whole. */
async function inlineContinuation(db: RelationalStore, projectId: string, transcriptId: string, offset: number, instance: string | null,
  raw: unknown): Promise<Record<string, unknown> | null> {
  if (typeof raw !== 'string') return null;
  const context = JSON.parse(raw) as Record<string, unknown>;
  const state = context.mycoParserState as { chunked?: unknown; digest?: unknown } | undefined;
  if (state?.chunked !== true) return context;
  if (instance === null) return { ...context, mycoParserState: await readParserCheckpoint(db, { projectId, transcriptId, parsedOffset: offset }, state.digest) };
  const held = (await db.prepare(`SELECT chunk_index,chunk_count,payload FROM view_checkpoint_chunks WHERE project_id=? AND instance_id=?
    AND transcript_id=? AND cursor_offset=? ORDER BY chunk_index`).bind(projectId, instance, transcriptId, offset)
    .all<{ chunk_index: number; chunk_count: number; payload: string }>()).results;
  const encoded = held.map((row) => row.payload).join('');
  if (held.length === 0 || held.some((row, i) => row.chunk_index !== i || row.chunk_count !== held.length) || await sha256HexOf(utf8(encoded)) !== state.digest)
    throw new Error('document_conversion_continuation_incomplete');
  return { ...context, mycoParserState: JSON.parse(encoded) as unknown };
}

/** Converts sessions that predate documents, newest first, within what the wake has left. */
export async function convertDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  let changed = 0;
  for (let pages = 0; ; pages += 1) {
    if (pages >= Math.max(1, Math.floor(limits.calls / CONVERT_CALLS_PER_PAGE))) return { changed, more: true };
    if (limits.clock() >= limits.deadline || reserveReached(env.db, 2 * PASS_CLOSING_STATEMENTS, 2 * PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
    const next = await env.db.prepare(`SELECT d.project_id,d.session_id FROM session_documents d JOIN sessions s
        ON s.project_id=d.project_id AND s.session_id=d.session_id
      WHERE d.state='convert' AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)
      ORDER BY s.last_received_at DESC,d.session_id LIMIT 1`).first<{ project_id: string; session_id: string }>();
    if (next === null) return { changed, more: false };
    changed += await convertPage(env, next.project_id, next.session_id, now);
  }
}

/** One bounded step of one session's conversion: adoption, one export page, or the flip. Returns the records placed. */
export async function convertPage(env: Pick<ServerEnv, 'db' | 'blobs'>, projectId: string, sessionId: string, now: number): Promise<number> {
  const db = env.db;
  const [docs, chunks, pages] = await db.batch([
    db.prepare(`SELECT ${GENERATION} generation,d.next_chunk,d.prompts,d.first_prompt,d.open_turn_key,d.build,s.created_by_token_id token_id
      FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
      WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='convert'`).bind(projectId, sessionId),
    ...directoryStatements(db, projectId, sessionId),
  ]);
  const doc = docs!.results[0] as ConvertingRow | undefined;
  if (doc === undefined) return 0;
  const batch = new DocumentBatch(env, projectId, sessionId, doc, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
  await batch.open();
  let build: Build;
  let adopting = false;
  if (doc.build === null) {
    build = await adopt(db, projectId, sessionId, batch);
    adopting = true;
  } else build = JSON.parse(doc.build) as Build;
  const plan = steps(build);
  const step = plan[build.step];
  if (!adopting && step !== undefined) {
    const [material, source] = step;
    const [after, key] = build.after ?? [-1, ''];
    const binds: unknown[] = [projectId, sessionId, after, key, ...(source === 'fact' ? [] : [build.live, ...(source === 'parent' ? [build.parent] : [])])];
    const rows = (await db.prepare(EXPORTS[material.kind][source === 'fact' && !build.published ? 'legacy' : source]).bind(...binds)
      .all<Record<string, unknown>>()).results;
    if (rows.length === 0) build = { ...build, step: build.step + 1, after: null };
    else {
      const records = await Promise.all(rows.map(async (row) => materialRecord(material.kind, await hydrated(env, projectId, material, row, build.report))));
      const before = batch.inserted.length;
      await batch.place(records, null);
      const placed = batch.inserted.slice(before).filter(([kind]) => kind === material.kind).map(([, id]) => id);
      const ids = build.report.ids[material.kind]!;
      build.report.ids[material.kind] = {
        rows: await foldIds(ids.rows, material.kind, rows.map((row) => String(row[material.kind === 'plan' ? 'plan_key' : material.id]))),
        records: await foldIds(ids.records, material.kind, placed),
      };
      count(build.report.rows, material.kind, rows.length);
      count(build.report.records, material.kind, placed.length);
      count(build.report.classes, 'unplaced', batch.unplaced);
      count(build.report.classes, 'unresolved_prompt', batch.unresolved);
      const last = rows.at(-1)!;
      build = { ...build, after: [Number(last.created_at), String(last[material.id])] };
    }
  }
  const flip = !adopting && build.step >= plan.length;
  if (flip) await finishReport(db, projectId, sessionId, build.report);
  const expected = doc.build;
  await batch.commit(adopting || batch.writer.changed, 'building', now, (version) => ({
    sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='convert')
      AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
    params: [projectId, sessionId, projectId, sessionId, version.key, version.sourceId],
  }), (registered) =>
    conversionStatements(db, projectId, sessionId, doc, batch, registered, expected, build, flip, now));
  if (flip) emit({ kind: 'document_converted', projectId, sessionId, classes: build.report.classes });
  return batch.records;
}

/** Reads each transcript's effective frontier, continuation and policy, and the session's key owners, in one batch. */
async function adopt(db: RelationalStore, projectId: string, sessionId: string, batch: DocumentBatch): Promise<Build> {
  const live = `(SELECT live_instance FROM session_views WHERE project_id=?1 AND session_id=?2 AND legacy IN ('published','cleaning','gone'))`;
  const [visible, transcripts, viewOwners, keyOwners] = await db.batch([
    db.prepare(`SELECT v.instance_id,v.role FROM view_visible v WHERE v.project_id=?1 AND v.session_id=?2 AND ${live} IS NOT NULL`).bind(projectId, sessionId),
    db.prepare(`SELECT t.transcript_id,t.prompt_identity_scheme,t.record_identity_scheme,t.parsed_offset,t.parser_context,t.open_prompt_id,
        t.parse_segment_lines,t.parse_error,t.parse_awaited_size,c.transcript_id c_transcript,c.parsed_offset c_offset,c.parser_context c_context,
        c.open_prompt_id c_prompt,c.parse_segment_lines c_lines,c.parse_error c_error,c.parse_awaited_size c_awaited
      FROM transcripts t LEFT JOIN view_checkpoints c ON c.project_id=t.project_id AND c.transcript_id=t.transcript_id AND c.instance_id=${live}
      WHERE t.project_id=?1 AND t.session_id=?2`).bind(projectId, sessionId),
    db.prepare(`SELECT source_key,source_thread,source_record FROM view_key_owners WHERE project_id=?1 AND instance_id=${live}`).bind(projectId, sessionId),
    db.prepare(`SELECT source_key,source_thread,source_record FROM prompt_key_owners WHERE project_id=?1 AND session_id=?2`).bind(projectId, sessionId),
  ]);
  const instances = visible!.results as { instance_id: string; role: string }[];
  const liveInstance = instances.find((row) => row.role === 'live')?.instance_id ?? null;
  const published = liveInstance !== null;
  const adopted: Record<string, unknown>[] = [];
  for (const t of transcripts!.results as Record<string, unknown>[]) {
    const viewed = published;
    const held = viewed ? t.c_transcript !== null : true;
    const offset = Number((viewed ? t.c_offset : t.parsed_offset) ?? 0);
    const context = held ? await inlineContinuation(db, projectId, String(t.transcript_id), offset, viewed ? liveInstance : null,
      viewed ? t.c_context : t.parser_context) : null;
    if (context !== null) batch.writer.states.set(String(t.transcript_id), context);
    const error = held ? (viewed ? t.c_error : t.parse_error) : null;
    adopted.push({
      t: t.transcript_id, o: held ? offset : 0, l: held ? Number((viewed ? t.c_lines : t.parse_segment_lines) ?? 0) : 0,
      p: held ? (viewed ? t.c_prompt : t.open_prompt_id) ?? null : null,
      u: context?.mycoParserUnfinished === 1 ? 1 : 0, r: context?.mycoParserReplyUnfinished === 1 ? 1 : 0,
      a: typeof context?.mycoParserReplyLatestAt === 'number' ? context.mycoParserReplyLatestAt : null,
      ps: viewed ? publishedPromptScheme(t.prompt_identity_scheme) : t.prompt_identity_scheme,
      rs: viewed ? PUBLISHED_RECORD_SCHEME : t.record_identity_scheme,
      s: error === null || error === undefined ? 'active' : error === 'awaiting_bytes' ? 'awaiting' : 'failed',
      f: error === 'awaiting_bytes' ? null : error ?? null,
      w: error === 'awaiting_bytes' ? (viewed ? t.c_awaited : t.parse_awaited_size) ?? null : null,
    });
  }
  const owners = (published ? viewOwners : keyOwners)!.results as { source_key: string; source_thread: string; source_record: string }[];
  for (const row of owners) batch.writer.owners.set(row.source_key, { thread: row.source_thread, record: row.source_record });
  return {
    published, live: liveInstance, parent: instances.find((row) => row.role === 'parent')?.instance_id ?? null,
    step: 0, after: null, adopted, report: emptyReport(),
  };
}

/** A row with its retained bodies read back; a body that cannot be read keeps its preview and is reported by class. */
async function hydrated(env: Pick<ServerEnv, 'db' | 'blobs'>, projectId: string, material: Material, row: Record<string, unknown>,
  report: ConversionReport): Promise<Record<string, unknown>> {
  const out = { ...row };
  if (material.kind === 'tool' && typeof row.output_blob_key === 'string') count(report.classes, 'output_preview_only');
  for (const [blobColumn, field] of material.bodies) {
    const key = row[blobColumn];
    if (typeof key !== 'string') continue;
    const blob = await env.db.prepare('SELECT generation,size FROM blobs WHERE project_id=? AND key=?').bind(projectId, key)
      .first<{ generation: string | null; size: number }>();
    if (blob === null) { count(report.classes, 'body_missing'); continue; }
    try {
      out[field] = await readVerifiedContentText(env, blobObjectKey(projectId, key, blob.generation), blob.size, key);
      report.bodies += 1;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('content_')) throw error;
      count(report.classes, 'body_unreadable');
    }
  }
  if (material.kind === 'tool' && typeof row.input_bundle_id === 'number' && typeof row.input_blob_key !== 'string') {
    try {
      out.input = await readBundleEntry(env, { projectId, bundleId: row.input_bundle_id, entry: Number(row.input_bundle_entry),
        kind: 'tool-input', resourceId: String(row.tool_call_id), tokenId: String(row.token_id) });
      report.bodies += 1;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('content_')) throw error;
      count(report.classes, 'body_unreadable');
    }
  }
  return out;
}

/** The difference classes a finished export reports: id sets that differ, and cards whose turn the document lacks. */
async function finishReport(db: RelationalStore, projectId: string, sessionId: string, report: ConversionReport): Promise<void> {
  for (const [kind, ids] of Object.entries(report.ids))
    if (ids.rows !== ids.records || (report.rows[kind] ?? 0) !== (report.records[kind] ?? 0)) count(report.classes, `ids_differ:${kind}`);
  const cards = await db.prepare(`SELECT COUNT(*) n FROM turn_cards c WHERE c.project_id=? AND c.session_id=?
    AND NOT EXISTS (SELECT 1 FROM session_prompts p WHERE p.project_id=c.project_id AND p.session_id=c.session_id AND p.generation=${GENERATION}
      AND p.prompt_id=c.turn_key AND p.turn_key=p.prompt_id)`).bind(projectId, sessionId).first<{ n: number }>();
  count(report.classes, 'card_without_turn', Number(cards?.n ?? 0));
}

function conversionStatements(db: RelationalStore, projectId: string, sessionId: string, doc: ConvertingRow, batch: DocumentBatch,
  registered: readonly ChunkVersion[], expected: string | null, build: Build, flip: boolean, now: number): { before: PreparedStatement[]; after: PreparedStatement[] } {
  const before = contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='convert'
      AND next_chunk=? AND build IS ?)
    AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=${GENERATION}
      AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))`,
  [projectId, sessionId, doc.next_chunk, expected, batch.expectedChunks(registered), projectId, sessionId]);
  const set = batch.documentSet(now);
  if (!flip) {
    return { before, after: [db.prepare(`UPDATE session_documents SET ${set.sql},build=? WHERE project_id=? AND session_id=?`)
      .bind(...set.params, JSON.stringify(build), projectId, sessionId)] };
  }
  return {
    before,
    after: [
      db.prepare(`UPDATE session_chunks SET state='live' WHERE project_id=? AND session_id=? AND generation=${GENERATION}`).bind(projectId, sessionId),
      ...(build.adopted.length === 0 ? [] : [publicationStatement(db, projectId, sessionId, GENERATION, now, build.adopted)]),
      db.prepare(`UPDATE session_documents SET ${set.sql},state='live',generation=${GENERATION},due_at=0,build=? WHERE project_id=? AND session_id=?`)
        .bind(...set.params, JSON.stringify({ report: build.report }), projectId, sessionId),
    ],
  };
}
