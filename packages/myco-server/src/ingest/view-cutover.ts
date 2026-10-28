import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import type { ViewCutoverStatus } from '@goondocks/myco-shared/view-status';
import { contentAssertion } from '../core/registered-content.js';
import { measuredContentEnv, remainingInvocationBudget, CONTENT_WAKE_JOB_RESERVE, CONTENT_BLOB_LIMIT } from '../core/content-budget.js';
import { LEGACY_CLASS_TABLES, legacyRowSql, unverifiedRowSql, CLASSIFIED_AT_SQL } from '../db/schema-v106.js';
import { PARSERS } from './parsers/registry.js';
import { PARSER_VERSION, pendingTranscripts } from './parse.js';
import { requestViewRebuild } from './view-lifecycle.js';
import { runViewParseJob } from './view-run.js';
import { SERIAL_VIEW_BUDGET, PARALLEL_VIEW_BUDGET } from './view-build-queue.js';
import { productionFlipEnvelope } from './view-flip-calibration.js';
import { copyFrozenPage, startFrozenTail } from './view-frozen.js';

/** The hosted relational store holds at most 10 GB; the batch stops building at this size and keeps extending published sessions. */
export const VIEW_CUTOVER_PAUSE_BYTES = 9_000_000_000;
export const CLASSIFY_PAGE_ROWS = 256;
const CLASSIFY_PAGES_PER_WAKE = 4;
const SWEEP_PAGE_TRANSCRIPTS = 64;
const SWEEP_SESSIONS_PER_WAKE = 8;

interface CutoverState {
  classify_stage: number;
  classify_after: number;
  classified_at: number | null;
  sweep_after: number;
  swept_at: number | null;
  paused_reason: string | null;
}

async function cutoverState(db: RelationalStore, now: number): Promise<CutoverState> {
  await db.prepare(`INSERT OR IGNORE INTO cutover_progress(id,updated_at) VALUES(1,?)`).bind(now).run();
  return (await db
    .prepare(
      `SELECT classify_stage,classify_after,classified_at,sweep_after,swept_at,paused_reason FROM cutover_progress WHERE id=1`,
    )
    .first<CutoverState>())!;
}

/** The Deployment's stored size, where its relational store reports one. */
export async function databaseBytes(db: RelationalStore): Promise<number | null> {
  const result = await db.prepare(`SELECT 1`).run();
  const size = Reflect.get(result.meta, 'size_after');
  return typeof size === 'number' && Number.isFinite(size) ? size : null;
}

/** One page of the parser-row backfill, with the rows it classified; the triggers classify every later row. */
export async function classifyLegacyPage(db: RelationalStore, now: number): Promise<{ more: boolean; classified: number }> {
  const state = await cutoverState(db, now);
  if (state.classify_stage >= LEGACY_CLASS_TABLES.length) return { more: false, classified: 0 };
  const { table, id } = LEGACY_CLASS_TABLES[state.classify_stage]!;
  const bound = await db
    .prepare(`SELECT rowid r FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1 OFFSET ?`)
    .bind(state.classify_after, CLASSIFY_PAGE_ROWS - 1)
    .first<{ r: number }>();
  const last = state.classify_stage + 1 === LEGACY_CLASS_TABLES.length && bound === null;
  const assertion = contentAssertion(db, `EXISTS(SELECT 1 FROM cutover_progress WHERE id=1 AND classify_stage=? AND classify_after=?)`, [
    state.classify_stage,
    state.classify_after,
  ]);
  const results = await db.batch([
    ...assertion,
    db
      .prepare(
        `INSERT OR IGNORE INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at)
      SELECT r.project_id,'${table}',r.${id},r.session_id,CASE WHEN ${legacyRowSql(table, 'r')} THEN 'legacy' ELSE 'unverified' END,${CLASSIFIED_AT_SQL}
      FROM ${table} r WHERE r.rowid>? AND r.rowid<=? AND (${legacyRowSql(table, 'r')} OR ${unverifiedRowSql('r')})`,
      )
      .bind(state.classify_after, bound?.r ?? Number.MAX_SAFE_INTEGER),
    db
      .prepare(
        `UPDATE cutover_progress SET classify_stage=?,classify_after=?,classified_at=?,updated_at=? WHERE id=1`,
      )
      .bind(
        bound === null ? state.classify_stage + 1 : state.classify_stage,
        bound?.r ?? 0,
        last ? now : null,
        now,
      ),
  ]);
  return { more: !last, classified: results[assertion.length]?.meta.changes ?? 0 };
}

const heldSource = `SELECT base_offset b,base_offset+length e FROM transcript_segments WHERE project_id=t.project_id AND transcript_id=t.transcript_id
  UNION ALL SELECT base_offset,base_offset+length FROM raw_archive_refs WHERE project_id=t.project_id AND transcript_id=t.transcript_id
    AND source_kind='transcript' AND disposition='archived'`;
/** A transcript is held from zero when its held ranges start at 0 and cover its size with no gap. */
export const HELD_FROM_ZERO_SQL = `(t.size=0 OR COALESCE((SELECT MIN(b) FROM (${heldSource})),-1)=0
  AND COALESCE((SELECT MAX(e) FROM (${heldSource})),0)>=t.size
  AND NOT EXISTS(SELECT 1 FROM (SELECT b,MAX(e) OVER(ORDER BY b,e ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) reach FROM (${heldSource}))
    WHERE reach IS NOT NULL AND b>reach))`;

/** Sessions with a parser-read transcript and no view yet enter the build queue, or a frozen tail when bytes were lost. */
export async function sweepViewCutover(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number): Promise<number> {
  const db = env.db,
    state = await cutoverState(db, now);
  const rows = (
    await db
      .prepare(
        `SELECT t.rowid r,t.project_id,t.session_id,
      CASE WHEN EXISTS(SELECT 1 FROM sessions s WHERE s.project_id=t.project_id AND s.session_id=t.session_id)
        AND NOT EXISTS(SELECT 1 FROM session_views v WHERE v.project_id=t.project_id AND v.session_id=t.session_id)
        AND NOT EXISTS(SELECT 1 FROM session_tombstones x WHERE x.project_id=t.project_id AND x.session_id=t.session_id) THEN 1 ELSE 0 END needed
      FROM transcripts t WHERE t.rowid>? AND t.agent IN(SELECT value FROM json_each(?)) ORDER BY t.rowid LIMIT ?`,
      )
      .bind(state.sweep_after, JSON.stringify(Object.keys(PARSERS)), SWEEP_PAGE_TRANSCRIPTS)
      .all<{ r: number; project_id: string; session_id: string; needed: number }>()
  ).results;
  const queued = new Set<string>();
  let after = state.sweep_after;
  for (const row of rows) {
    const key = JSON.stringify([row.project_id, row.session_id]);
    if (row.needed === 1 && !queued.has(key)) {
      if (queued.size >= SWEEP_SESSIONS_PER_WAKE) break;
      queued.add(key);
      const lost = await db
        .prepare(
          `SELECT 1 FROM transcripts t WHERE t.project_id=? AND t.session_id=? AND NOT ${HELD_FROM_ZERO_SQL} LIMIT 1`,
        )
        .bind(row.project_id, row.session_id)
        .first();
      try {
        if (lost === null) await requestViewRebuild(db, row.project_id, row.session_id, now);
        else await startFrozenTail(env, row.project_id, row.session_id, now);
      } catch (error) {
        if (!(error instanceof Error) || !/view_rebuild_request_conflict|CHECK constraint failed/.test(error.message))
          throw error;
      }
    }
    after = row.r;
  }
  const passed = rows.length < SWEEP_PAGE_TRANSCRIPTS && after === (rows.at(-1)?.r ?? state.sweep_after);
  await db
    .prepare(
      `UPDATE cutover_progress SET sweep_after=?,swept_at=CASE WHEN ? THEN ? ELSE swept_at END,updated_at=? WHERE id=1`,
    )
    .bind(passed ? 0 : after, passed ? 1 : 0, now, now)
    .run();
  return queued.size;
}

/** Status of the batch: classification, sessions built and remaining, frozen tails, the headroom pause. */
export async function readViewCutover(db: RelationalStore): Promise<ViewCutoverStatus> {
  const row = await db
    .prepare(
      `SELECT (SELECT classified_at FROM cutover_progress WHERE id=1) classified_at,
      (SELECT swept_at FROM cutover_progress WHERE id=1) swept_at,
      (SELECT paused_reason FROM cutover_progress WHERE id=1) paused_reason,
      (SELECT database_bytes FROM cutover_progress WHERE id=1) database_bytes,
      (SELECT COUNT(*) FROM session_views s JOIN view_instances i ON i.project_id=s.project_id AND i.instance_id=s.live_instance
        WHERE i.parser_version=?) built,
      (SELECT COUNT(*) FROM (SELECT DISTINCT t.project_id,t.session_id FROM transcripts t
        WHERE t.agent IN(SELECT value FROM json_each(?))
          AND NOT EXISTS(SELECT 1 FROM session_tombstones x WHERE x.project_id=t.project_id AND x.session_id=t.session_id)
          AND NOT EXISTS(SELECT 1 FROM session_views s JOIN view_instances i ON i.project_id=s.project_id AND i.instance_id=s.live_instance
            WHERE s.project_id=t.project_id AND s.session_id=t.session_id AND i.parser_version=?))) remaining,
      (SELECT COUNT(*) FROM view_instances WHERE base='frozen') frozen_tails,
      (SELECT COUNT(*) FROM view_instances WHERE base='frozen' AND state='building') frozen_copying`,
    )
    .bind(PARSER_VERSION, JSON.stringify(Object.keys(PARSERS)), PARSER_VERSION)
    .first<{
      classified_at: number | null;
      swept_at: number | null;
      paused_reason: string | null;
      database_bytes: number | null;
      built: number;
      remaining: number;
      frozen_tails: number;
      frozen_copying: number;
    }>();
  return {
    classified: row?.classified_at !== null && row?.classified_at !== undefined,
    swept: row?.swept_at !== null && row?.swept_at !== undefined,
    paused: row?.paused_reason ?? null,
    databaseBytes: row?.database_bytes ?? null,
    built: row?.built ?? 0,
    remaining: row?.remaining ?? 0,
    frozenTails: row?.frozen_tails ?? 0,
    frozenCopying: row?.frozen_copying ?? 0,
  };
}

/** While legacy transcripts wait, the batch takes half of what a bounded wake leaves its parsers; the legacy pass takes the rest. */
async function cutoverShare(env: ServerEnv, now: number): Promise<ServerEnv> {
  const held = remainingInvocationBudget(env.db);
  if (held === null || (await pendingTranscripts(env.db, now)).transcripts === 0) return env;
  return measuredContentEnv(env, {
    statements: CONTENT_WAKE_JOB_RESERVE + Math.floor(Math.max(0, held.statements - 2 * CONTENT_WAKE_JOB_RESERVE) / 2),
    blobCalls: CONTENT_BLOB_LIMIT + Math.floor(Math.max(0, held.blobCalls - 2 * CONTENT_BLOB_LIMIT) / 2),
  }).env;
}

/** One wake of the batch: classify, check headroom, sweep, copy frozen derivations, then build and publish. */
export async function runViewCutoverWake(wake: ServerEnv, now: number, readBytes = databaseBytes) {
  const env = await cutoverShare(wake, now);
  const db = env.db;
  const bytes = await readBytes(db);
  const paused = bytes !== null && bytes >= VIEW_CUTOVER_PAUSE_BYTES;
  await cutoverState(db, now);
  await db
    .prepare(
      `UPDATE cutover_progress SET paused_reason=?,database_bytes=COALESCE(?,database_bytes),observed_at=?,updated_at=? WHERE id=1`,
    )
    .bind(paused ? 'd1_headroom' : null, bytes, now, now)
    .run();
  let changed = 0;
  let classifying = true;
  for (let pass = 0; classifying && pass < CLASSIFY_PAGES_PER_WAKE; pass++) {
    const page = await classifyLegacyPage(db, now);
    classifying = page.more;
    changed += page.classified;
  }
  const state = await cutoverState(db, now);
  const classified = state.classified_at !== null;
  if (classified && !paused) {
    changed += await sweepViewCutover(env, now);
    changed += await copyFrozenPage(env, now);
  }
  const native = env.platform.name === 'bun';
  const profile = native ? PARALLEL_VIEW_BUDGET : SERIAL_VIEW_BUDGET;
  const report = await runViewParseJob(env, now, {
    profile,
    envelope: productionFlipEnvelope(native ? 'native' : 'remote', native ? 'parallel' : 'serial'),
    cutover: true,
    buildPaused: paused || !classified,
    mirrorFrontier: false,
  });
  changed += report.changed + report.published;
  const pending = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM view_build_work WHERE state<>'waiting')
      OR EXISTS(SELECT 1 FROM view_instances WHERE base='frozen' AND state='building')
      OR EXISTS(SELECT 1 FROM cutover_progress WHERE id=1 AND swept_at IS NULL) pending`,
    )
    .first<{ pending: number }>();
  return { changed, more: !paused && (!classified || pending?.pending === 1) };
}
