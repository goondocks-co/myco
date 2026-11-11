import { storedCardFields } from '@goondocks/myco-shared/turn-card';
import { jsonPages } from '../db/json-pages.js';
import { cardHeadlineStatement, cardsMissingHeadlines } from '../db/learning/cards.js';
import { commit } from '../db/index.js';
import type { ServerEnv } from '../core/adapters.js';
import { cardOutline } from '../core/turn-cards.js';
import { sessionEditPaths } from '../db/documents/edit-paths.js';
import { prepareBound } from '../db/kernel/statement.js';
import { contentAssertion } from '../db/storage/content-guard.js';
import { registeredObjectKeySql } from '../db/storage/registered-object-key.js';
import { readBodyChunk, readPageChunk, type ChunkRow } from '../content/document-reader.js';
import { SESSION_OWNER } from '../db/document-tables.js';
import { adjustToolState, editedFiles, emptyToolState, recordMycoFields, needsToolInput, parseToolState, scalarToolState, toolFiles, type ToolState } from '../content/tool-rollup.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached, SESSION_PATHS_LIMIT } from './document-batch.js';
import { turnStatisticsStatements, type DocumentKey, type StatisticsChange } from '../db/documents/turn-statistics.js';
import { deferDocumentReadFailure } from './document-read-failures.js';
import type { PassLimits } from './parse.js';

const SUMMARY_PAGES = 50;
interface Build { epoch: number; pages: number; state: ToolState }
interface PathBuild { path: string; calls: number; edits: number; at: number; turn: string | null }
interface Pending {
  project_id: string; session_id: string; generation: number; publication_input_revision: number; rollup_after: number; rollup_page: number; rollup_epoch: number;
  paths_build: string | null; agent: string | null;
  myco_build: number; rollup_record: number;
}

/** Catches up catalog summaries on the publisher's remaining locator share. */
export async function catchUpSummaries(env: Pick<ServerEnv, 'db' | 'blobs'>, limits: PassLimits, chunks: number) {
  const db = env.db;
  let changed = 0;
  const now = limits.clock();
  for (let pass = 0, read = 0; pass < chunks && read < chunks; pass += 1) {
    if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
    const doc = await db.prepare(`SELECT d.project_id,d.session_id,d.generation,d.publication_input_revision,d.rollup_after,d.rollup_page,d.rollup_epoch,d.paths_build,d.myco_build,d.rollup_record,s.agent
      FROM session_documents d INDEXED BY idx_session_documents_rollup
      JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
      WHERE d.rollup_after IS NOT NULL AND d.state='live' AND d.rollup_due<=?
      ORDER BY d.rollup_due,d.rollup_checked,d.project_id,d.session_id LIMIT 1`).bind(now).first<Pending>();
    if (doc === null) break;
    try {
    const key: DocumentKey = [doc.project_id, doc.session_id, doc.generation];
    const rows = (await db.prepare(`SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,
        ${registeredObjectKeySql('c.project_id', 'c.blob_key')} AS object_key
      FROM session_chunks c INDEXED BY idx_session_chunks_pages
      WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.kind='page' AND c.chunk_no>?4
      ORDER BY c.chunk_no LIMIT 2`).bind(...key, doc.rollup_after).all<ChunkRow>()).results;
    const row = rows[0] ?? null;
    const paths = doc.paths_build === null
      ? (await db.prepare(`SELECT path FROM session_paths WHERE project_id=? AND session_id=? AND generation=? ORDER BY path LIMIT ?`)
        .bind(...key, SESSION_PATHS_LIMIT).all<{ path: string }>()).results.map(({ path }) => ({ path, calls: 0, edits: 0, at: 0, turn: null } as PathBuild))
      : (await db.prepare(`SELECT path,calls,edits,at,turn FROM session_path_build
        WHERE project_id=? AND session_id=? AND generation=? ORDER BY path LIMIT ?`).bind(...key, SESSION_PATHS_LIMIT).all<PathBuild>()).results;
    const pathMap = new Map(paths.map(path => [path.path, path]));
    const changedPaths = new Set(doc.paths_build === null ? paths.map(path => path.path) : []);
    if (row !== null) read += 1;
    const decoded = row === null ? [] : (await readPageChunk(env, row)).pages;

    const pages = decoded.slice(doc.rollup_page, doc.rollup_page + SUMMARY_PAGES);
    const held = pages.length === 0 ? [] : (await db.prepare(`SELECT p.owner,p.page,sp.tool_state,sp.rollup_build,sp.tool_revision,
        (SELECT tail.page FROM session_pages tail WHERE tail.project_id=?1 AND tail.session_id=?2 AND tail.generation=?3
          AND tail.owner=p.owner ORDER BY tail.page DESC LIMIT 1) AS last_page
      FROM json_each(?4) j CROSS JOIN session_pages p
        ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.owner=json_extract(j.value,'$.owner') AND p.page=json_extract(j.value,'$.page')
      LEFT JOIN session_prompts sp ON sp.project_id=p.project_id AND sp.session_id=p.session_id AND sp.generation=p.generation AND sp.prompt_id=p.owner
      WHERE p.chunk_no=?5`).bind(...key, JSON.stringify(pages.map(page => ({ owner: page.owner, page: page.page }))), row!.chunk_no)
      .all<{ owner: string; page: number; tool_state: string | null; rollup_build: string | null; tool_revision: number | null; last_page: number }>()).results;
    const builds = new Map<string, Build & { lastPage: number }>();
    const edited: string[] = [];
    const statistics = new Map<string, StatisticsChange>();
    let capped = false;
    const harnesses = new Map<string, string | null>();
    let mycoCalls = doc.myco_build;
    let pageAt = doc.rollup_page, recordAt = doc.rollup_record;
    let paused = false;
    for (const page of pages) {
      const prior = held.find(held => held.owner === page.owner && held.page === page.page);
      if (prior === undefined) { pageAt += 1; recordAt = 0; continue; }
      let build = builds.get(page.owner);
      if (page.owner !== SESSION_OWNER && prior.tool_state === null && build === undefined) {
        const saved = prior.rollup_build === null ? null : JSON.parse(prior.rollup_build) as Build;
        build = { ...(saved?.epoch === doc.rollup_epoch ? saved : { epoch: doc.rollup_epoch, pages: 0, state: emptyToolState() }), lastPage: prior.last_page };
        builds.set(page.owner, build);
        const reset = saved?.epoch !== doc.rollup_epoch;
        statistics.set(page.owner, { id: page.owner, state: build.state, reset });
      }
      for (; recordAt < page.records.length; recordAt += 1) {
        if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) { paused = true; break; }
        let record = page.records[recordAt]!;
        let harness = typeof record.harness === 'string' ? record.harness : doc.agent;
        if (record.k === 'tool' && !Object.hasOwn(record, 'harness') && record.src !== undefined) {
          const transcript = record.src[0];
          if (!harnesses.has(transcript)) {
            const source = await db.prepare('SELECT agent FROM transcripts WHERE project_id=? AND transcript_id=?')
              .bind(doc.project_id, transcript).first<{ agent: string | null }>();
            if (source === null) throw new Error('document_transcript_missing');
            harnesses.set(transcript, source.agent);
          }
          harness = harnesses.get(transcript)!;
        }
        const ref = record.k === 'tool' ? record.bodies?.input : undefined;
        if (ref !== undefined && needsToolInput(record, harness)) {
          if (read >= chunks || limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) { paused = true; break; }
          const body = await db.prepare(`SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,
              ${registeredObjectKeySql('c.project_id', 'c.blob_key')} AS object_key
            FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.chunk_no=?4`)
            .bind(...key, ref.chunk).first<ChunkRow>();
          if (body === null || body.blob_key !== ref.digest || body.bytes !== ref.bytes) throw new Error('document_body_reference');
          read += 1;
          record = { ...record, input: await readBodyChunk(env, body) };
        }
        if (build !== undefined) adjustToolState(build.state, record, harness, 1);
        if (record.k !== 'tool') continue;
        if (recordMycoFields(record).tool !== null) mycoCalls += 1;
        const edits = editedFiles(record, harness);
        edited.push(...edits);
        for (const path of toolFiles(record, harness)) {
          let held = pathMap.get(path);
          if (held === undefined && paths.length < SESSION_PATHS_LIMIT) {
            held = { path, calls: 0, edits: 0, at: 0, turn: null };
            paths.push(held); pathMap.set(path, held);
          }
          if (held === undefined) { capped = true; continue; }
          changedPaths.add(path);
          held.calls += 1;
          if (edits.includes(path)) held.edits += 1;
          if (record.created_at >= held.at) { held.at = record.created_at; held.turn = page.owner === SESSION_OWNER ? null : page.owner; }
        }
      }
      if (paused) break;
      if (build !== undefined) build.pages += 1;
      pageAt += 1; recordAt = 0;
    }
    const updates = [...builds].map(([id, build]) => {
      const complete = build.pages === build.lastPage + 1;
      const scalar = scalarToolState(build.state);
      return { id, build: complete ? null : JSON.stringify({ epoch: build.epoch, pages: build.pages, state: parseToolState(scalar) }),
        ...(complete ? { state: scalar, failed: build.state.failed, myco: build.state.mycoCalls } : {}) };
    });
    const completeChunk = pageAt >= decoded.length;
    const finished = row === null || (completeChunk && rows.length === 1);
    const revisions = [...new Map(held.filter(row => row.tool_revision !== null).map(row => [row.owner, { id: row.owner, revision: row.tool_revision }])).values()];
    const writes = [
      ...contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND generation=? AND state='live'
        AND rollup_epoch=? AND rollup_after=? AND rollup_page=? AND rollup_record=?)`, [...key, doc.rollup_epoch, doc.rollup_after, doc.rollup_page, doc.rollup_record]),
      ...contentAssertion(db, row === null
        ? `NOT EXISTS (SELECT 1 FROM session_chunks WHERE project_id=? AND session_id=? AND generation=? AND kind='page' AND chunk_no>?)`
        : `EXISTS (SELECT 1 FROM session_chunks c WHERE c.project_id=? AND c.session_id=? AND c.generation=? AND c.chunk_no=? AND c.blob_key=?
            AND (?=0 OR NOT EXISTS (SELECT 1 FROM session_chunks tail WHERE tail.project_id=c.project_id AND tail.session_id=c.session_id
              AND tail.generation=c.generation AND tail.kind='page' AND tail.chunk_no>c.chunk_no)))`,
        row === null ? [...key, doc.rollup_after] : [...key, row.chunk_no, row.blob_key, finished ? 1 : 0]),
      ...jsonPages(revisions).flatMap(page => contentAssertion(db, `NOT EXISTS (
        SELECT 1 FROM json_each(?4) j LEFT JOIN session_prompts p ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3
          AND p.prompt_id=json_extract(j.value,'$.id') WHERE p.tool_revision IS NOT json_extract(j.value,'$.revision'))`,
        [...key, JSON.stringify(page)])),
      ...sessionEditPaths(doc.project_id, doc.session_id, doc.generation, edited).map(bound => prepareBound(db, bound)),
      ...jsonPages(updates).map(page => db.prepare(`UPDATE session_prompts SET rollup_build=json_extract(j.value,'$.build'),
          tool_state=COALESCE(json_extract(j.value,'$.state'),tool_state),tool_revision=tool_revision+1,
          failed_tools=COALESCE(json_extract(j.value,'$.failed'),failed_tools),myco_calls=COALESCE(json_extract(j.value,'$.myco'),myco_calls)
        FROM json_each(?4) j WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND prompt_id=json_extract(j.value,'$.id')
          AND prompt_id IN (SELECT json_extract(value,'$.id') FROM json_each(?4))`)
        .bind(...key, JSON.stringify(page))),
      ...turnStatisticsStatements(key, [...statistics.values()], updates.filter(update => update.state !== undefined).map(update => update.id)).map(bound => prepareBound(db, bound)),
      ...(doc.paths_build === null ? [db.prepare('DELETE FROM session_path_build WHERE project_id=? AND session_id=? AND generation=?').bind(...key)] : []),
      ...jsonPages(paths.filter(path => changedPaths.has(path.path))).map(page => db.prepare(`INSERT INTO session_path_build(project_id,session_id,generation,path,calls,edits,at,turn)
        SELECT ?1,?2,?3,json_extract(value,'$.path'),json_extract(value,'$.calls'),json_extract(value,'$.edits'),
          json_extract(value,'$.at'),json_extract(value,'$.turn') FROM json_each(?4) WHERE true
        ON CONFLICT(project_id,session_id,generation,path) DO UPDATE SET calls=excluded.calls,edits=excluded.edits,at=excluded.at,turn=excluded.turn`).bind(...key, JSON.stringify(page))),
      ...(finished ? [db.prepare(`INSERT INTO session_paths(project_id,session_id,generation,path,tool_calls,edits,last_at,last_turn)
        SELECT project_id,session_id,generation,path,calls,edits,at,turn FROM session_path_build WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND true
        ON CONFLICT(project_id,session_id,generation,path) DO UPDATE SET tool_calls=excluded.tool_calls,edits=excluded.edits,last_at=excluded.last_at,last_turn=excluded.last_turn`).bind(...key),
        db.prepare('DELETE FROM session_path_build WHERE project_id=? AND session_id=? AND generation=?').bind(...key)] : []),
      db.prepare(`UPDATE session_documents SET rollup_after=?,rollup_page=?,rollup_record=?,paths_build=?,myco_build=?,myco_calls=CASE WHEN ? THEN ? ELSE myco_calls END,
        paths_capped=MAX(paths_capped,?),rollup_failure=NULL,rollup_due=0,rollup_checked=MAX(rollup_checked+1,?)
        WHERE project_id=? AND session_id=? AND generation=?`)
        .bind(finished ? null : completeChunk ? row!.chunk_no : doc.rollup_after, completeChunk ? 0 : pageAt, completeChunk ? 0 : recordAt,
          finished ? null : '1', finished ? 0 : mycoCalls, finished ? 1 : 0, mycoCalls, capped ? 1 : 0, now, ...key),
    ];
    await db.batch(writes);
    changed += updates.length;
    } catch (error) { await deferDocumentReadFailure(env.db, doc, error, now); }
  }
  if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
  const cards = await cardsMissingHeadlines(db, SUMMARY_PAGES);
  if (cards.length > 0) await commit(db, ...cards.map(card => {
    const outline = cardOutline(storedCardFields(card.fields) ?? card.card);
    return cardHeadlineStatement(outline.headline, JSON.stringify(outline.marks), card.project_id, card.session_id, card.turn_key, card.card, card.fields);
  }));
  changed += cards.length;
  const pending = await db.prepare(`SELECT 1 AS pending FROM session_documents INDEXED BY idx_session_documents_rollup
    WHERE rollup_after IS NOT NULL AND state='live' AND rollup_due<=? ORDER BY rollup_due,rollup_checked,project_id,session_id LIMIT 1`).bind(now).first();
  return { changed, more: pending !== null || cards.length === SUMMARY_PAGES };
}
