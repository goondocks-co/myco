import { storedCardFields } from '@goondocks/myco-shared/turn-card';
import { jsonPages } from '../db/json-pages.js';
import { cardHeadlineStatement, cardsMissingHeadlines } from '../db/learning/cards.js';
import { commit } from '../db/index.js';
import type { ServerEnv } from '../core/adapters.js';
import { cardOutline } from '../core/turn-cards.js';
import { sessionEditPaths } from '../db/documents/edit-paths.js';
import {
  advanceRollupWrite, clearPathBuildWrite, dueRollupDocument, finishPathsWrites, rollupBodyChunk, rollupDue, rollupHeldPages, rollupPageChunks, rollupPaths,
  rollupPromptWrite, rollupReadHeld, rollupRevisionsHeld, rollupTranscriptAgent, savePathBuildWrite, type PathBuild,
} from '../db/documents/summary-rollup.js';
import { readBodyChunk, readPageChunk } from '../content/document-reader.js';
import { SESSION_OWNER } from '../db/document-tables.js';
import { adjustToolState, editedFiles, emptyToolState, recordMycoFields, needsToolInput, parseToolState, scalarToolState, toolFiles, type ToolState } from '../content/tool-rollup.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached, SESSION_PATHS_LIMIT } from './document-batch.js';
import { turnStatisticsStatements, type DocumentKey, type StatisticsChange } from '../db/documents/turn-statistics.js';
import { deferDocumentReadFailure } from './document-read-failures.js';
import type { PassLimits } from './parse.js';

const SUMMARY_PAGES = 50;
interface Build { epoch: number; pages: number; state: ToolState }

/** Catches up catalog summaries on the publisher's remaining locator share. */
export async function catchUpSummaries(env: Pick<ServerEnv, 'db' | 'blobs'>, limits: PassLimits, chunks: number) {
  const db = env.db;
  let changed = 0;
  const now = limits.clock();
  for (let pass = 0, read = 0; pass < chunks && read < chunks; pass += 1) {
    if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
    const doc = await dueRollupDocument(db, now);
    if (doc === null) break;
    try {
    const key: DocumentKey = [doc.project_id, doc.session_id, doc.generation];
    const rows = await rollupPageChunks(db, key, doc.rollup_after);
    const row = rows[0] ?? null;
    const paths: PathBuild[] = await rollupPaths(db, key, doc.paths_build !== null, SESSION_PATHS_LIMIT);
    const pathMap = new Map(paths.map(path => [path.path, path]));
    const changedPaths = new Set(doc.paths_build === null ? paths.map(path => path.path) : []);
    if (row !== null) read += 1;
    const decoded = row === null ? [] : (await readPageChunk(env, row)).pages;

    const pages = decoded.slice(doc.rollup_page, doc.rollup_page + SUMMARY_PAGES);
    const held = pages.length === 0 ? [] : await rollupHeldPages(db, key, JSON.stringify(pages.map(page => ({ owner: page.owner, page: page.page }))), row!.chunk_no);
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
            const source = await rollupTranscriptAgent(db, doc.project_id, transcript);
            if (source === null) throw new Error('document_transcript_missing');
            harnesses.set(transcript, source.agent);
          }
          harness = harnesses.get(transcript)!;
        }
        const ref = record.k === 'tool' ? record.bodies?.input : undefined;
        if (ref !== undefined && needsToolInput(record, harness)) {
          if (read >= chunks || limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) { paused = true; break; }
          const body = await rollupBodyChunk(db, key, ref.chunk);
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
    await commit(db,
      ...rollupReadHeld(key, doc, row === null ? null : { chunkNo: row.chunk_no, key: row.blob_key, last: finished }),
      ...jsonPages(revisions).flatMap(page => rollupRevisionsHeld(key, JSON.stringify(page))),
      ...sessionEditPaths(doc.project_id, doc.session_id, doc.generation, edited),
      ...jsonPages(updates).map(page => rollupPromptWrite(key, JSON.stringify(page))),
      ...turnStatisticsStatements(key, [...statistics.values()], updates.filter(update => update.state !== undefined).map(update => update.id)),
      ...(doc.paths_build === null ? [clearPathBuildWrite(key)] : []),
      ...jsonPages(paths.filter(path => changedPaths.has(path.path))).map(page => savePathBuildWrite(key, JSON.stringify(page))),
      ...(finished ? finishPathsWrites(key) : []),
      advanceRollupWrite(key, { after: finished ? null : completeChunk ? row!.chunk_no : doc.rollup_after, page: completeChunk ? 0 : pageAt,
        record: completeChunk ? 0 : recordAt, pathsBuild: finished ? null : '1', mycoBuild: finished ? 0 : mycoCalls, finished, mycoCalls, capped, now }),
    );
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
  return { changed, more: await rollupDue(db, now) || cards.length === SUMMARY_PAGES };
}
