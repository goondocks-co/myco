import { measuredContentEnv, remainingContentBudget, CONTENT_WALL_MS } from '../core/content-budget.js';
import {
  flipMeasurementAvailable,
  readFlipWork,
  flipWorkFits,
  flipWorkGuard,
  flipCalibrationBlocked,
  beginFlipObservation,
  finishFlipObservation,
  flipContentGuard,
  type FlipEnvelope,
} from './view-flip-work.js';
export type { FlipEnvelope } from './view-flip-work.js';
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { contentAssertion } from '../core/registered-content.js';
import { publicationVersionStatements, finishVersionStatements } from '../core/material-versions.js';
import { VIEW_MATERIALS } from '../db/view-tables.js';
import { PARSER_VERSION, TRANSCRIPT_IDLE_MS } from './parse.js';
import { viewTerminalSql, viewTerminalParams } from './view-terminal.js';
import { type ViewWriteTarget, viewWriteGuard, viewWriteOwned } from './view-guard.js';
import { liveFrontierMirrorStatements } from './view-checkpoint.js';
import { stampVersionStatements } from './view-writer.js';
import { VIEW_RECENT_MS, resetViewFailure } from './view-build-queue.js';
import { viewPlanTransitionStatements, viewSessionProjectionStatements } from './view-projections.js';
import { carriesCoverage, type CoverageIdentity } from '../core/coverage-carry.js';
import { startViewSample, publishViewSample } from './view-work-samples.js';

export const FINAL_CONVERSION_LIMIT = 64;
const REBUILD_REQUEST_ATTEMPTS = 3;
export type FlipResult =
  | { published: true; rows: number; wallMs: number; overrun: boolean }
  | {
      published: false;
      reason:
        | 'view_not_ready'
        | 'view_flip_content_wall_exceeded'
        | 'view_flip_admission_unavailable'
        | 'view_flip_budget_exhausted';
    };

/** An empty initial instance is admitted only before any session transcript exists. */
export async function createEmptyView(
  db: RelationalStore,
  project: string,
  session: string,
  now: number,
): Promise<string> {
  const instance = crypto.randomUUID();
  await db.batch([
    ...contentAssertion(
      db,
      `EXISTS(SELECT 1 FROM sessions WHERE project_id=? AND session_id=?)
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND NOT EXISTS(SELECT 1 FROM transcripts WHERE project_id=? AND session_id=?)
    AND NOT EXISTS(SELECT 1 FROM session_views WHERE project_id=? AND session_id=?)`,
      [project, session, project, session, project, session, project, session],
    ),
    db
      .prepare(
        `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,state,created_at,published_at)
      VALUES(?,?,?,?,'full','live',?,?)`,
      )
      .bind(project, instance, session, PARSER_VERSION, now, now),
    db
      .prepare(
        `INSERT INTO session_views(project_id,session_id,live_instance,fence,legacy,updated_at) VALUES(?,?,?,1,'published',?)`,
      )
      .bind(project, session, instance, now),
    db
      .prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,?,'live',0)`)
      .bind(project, instance, session),
  ]);
  return instance;
}

export async function requestViewRebuild(
  db: RelationalStore,
  project: string,
  session: string,
  now: number,
): Promise<string> {
  for (let attempt = 0; attempt < REBUILD_REQUEST_ATTEMPTS; attempt++) {
    try {
      return await requestViewRebuildOnce(db, project, session, now);
    } catch (error) {
      if (!(error instanceof Error) || !/CHECK constraint failed.*ok\s*=\s*1/i.test(error.message)) throw error;
    }
  }
  throw new Error('view_rebuild_request_conflict');
}

async function requestViewRebuildOnce(
  db: RelationalStore,
  project: string,
  session: string,
  now: number,
): Promise<string> {
  const state = await db
    .prepare(
      `SELECT s.live_instance,s.building_instance,s.fence,i.base FROM session_views s LEFT JOIN view_instances i
    ON i.project_id=s.project_id AND i.instance_id=s.live_instance WHERE s.project_id=? AND s.session_id=?`,
    )
    .bind(project, session)
    .first<{ live_instance: string | null; building_instance: string | null; fence: number; base: string | null }>();
  if (state?.base === 'frozen') throw new Error('view_tail_initialization_required');
  if (state?.building_instance) {
    const build = await db
      .prepare(`SELECT parser_version,state FROM view_instances WHERE project_id=? AND instance_id=?`)
      .bind(project, state.building_instance)
      .first<{ parser_version: number; state: string }>();
    if (build?.parser_version === PARSER_VERSION && build.state === 'building') {
      await db.batch([
        ...contentAssertion(
          db,
          `EXISTS(SELECT 1 FROM session_views s JOIN view_instances i
        ON i.project_id=s.project_id AND i.instance_id=s.building_instance WHERE s.project_id=? AND s.session_id=?
        AND s.building_instance=? AND s.fence=? AND s.live_instance IS ? AND i.state='building' AND i.parser_version=?)`,
          [project, session, state.building_instance, state.fence, state.live_instance, PARSER_VERSION],
        ),
        ...resetViewFailure(db, project, session),
      ]);
      return state.building_instance;
    }
  }
  const instance = crypto.randomUUID(),
    live = state?.live_instance ?? null,
    fence = state?.fence ?? 0;
  await db.batch([
    ...contentAssertion(
      db,
      `EXISTS(SELECT 1 FROM sessions WHERE project_id=? AND session_id=?)
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND (?=0 AND NOT EXISTS(SELECT 1 FROM session_views WHERE project_id=? AND session_id=?)
      OR EXISTS(SELECT 1 FROM session_views WHERE project_id=? AND session_id=? AND fence=? AND building_instance IS ?))`,
      [
        project,
        session,
        project,
        session,
        state ? 1 : 0,
        project,
        session,
        project,
        session,
        fence,
        state?.building_instance ?? null,
      ],
    ),
    ...(state?.building_instance
      ? [
          db
            .prepare(
              `UPDATE view_instances SET state='abandoned',lease_token=NULL,lease_expires_at=NULL WHERE project_id=? AND instance_id=?`,
            )
            .bind(project, state.building_instance),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at)
      SELECT ?,?,?,?,COALESCE((SELECT base FROM view_instances WHERE project_id=? AND instance_id=?),'full'),(SELECT parent_instance FROM view_instances WHERE project_id=? AND instance_id=?),'building',?`,
      )
      .bind(project, instance, session, PARSER_VERSION, project, live, project, live, now),
    db
      .prepare(
        `INSERT INTO session_views(project_id,session_id,live_instance,building_instance,fence,legacy,updated_at,rebuild_state)
      VALUES(?,?,?,?,?,'converting',?,'building') ON CONFLICT(project_id,session_id) DO UPDATE SET building_instance=excluded.building_instance,
      rebuild_state='building',next_attempt_at=NULL,unrebuildable_reason=NULL`,
      )
      .bind(project, session, live, instance, fence, now),
    db.prepare(`DELETE FROM view_build_work WHERE project_id=? AND session_id=?`).bind(project, session),
    db
      .prepare(
        `INSERT INTO view_build_work(project_id,session_id,instance_id,tier,recent_until,session_created_at,started_at)
      SELECT ?,?,?,CASE WHEN COALESCE(MAX(t.last_received_at),0)>? THEN 0 ELSE CASE WHEN ? IS NULL THEN 1 ELSE 2 END END,
      COALESCE(MAX(t.last_received_at),0)+?,COALESCE(s.started_at,s.first_received_at),? FROM sessions s LEFT JOIN transcripts t
      ON t.project_id=s.project_id AND t.session_id=s.session_id WHERE s.project_id=? AND s.session_id=? GROUP BY s.started_at,s.first_received_at`,
      )
      .bind(project, session, instance, now - VIEW_RECENT_MS, live, VIEW_RECENT_MS, now, project, session),
    ...manifestStatements(db, project, session, instance),
    ...startViewSample(db, project, session, instance),
  ]);
  return instance;
}

export function manifestStatements(
  db: RelationalStore,
  project: string,
  session: string,
  instance: string,
): PreparedStatement[] {
  return [
    db
      .prepare(
        `WITH previous AS(
      SELECT c.transcript_id,c.start_offset
      FROM view_instances i JOIN session_views s ON s.project_id=i.project_id AND s.session_id=i.session_id
      JOIN view_instances live ON live.project_id=s.project_id AND live.instance_id=s.live_instance AND live.base='tail'
      JOIN view_checkpoints c ON c.project_id=live.project_id AND c.instance_id=live.instance_id
      WHERE i.project_id=? AND i.instance_id=? AND i.base='tail')
    INSERT OR IGNORE INTO view_checkpoints(project_id,instance_id,session_id,transcript_id,ordinal,start_offset,parsed_offset,parser_context,open_prompt_id,lost_context,parser_version)
    SELECT ?,?,?,t.transcript_id,COALESCE((SELECT MAX(ordinal)+1 FROM view_checkpoints WHERE project_id=? AND instance_id=?),0)
      +row_number() OVER(ORDER BY CASE WHEN t.role='primary' THEN 0 ELSE 1 END,
        (SELECT MIN(created_at) FROM(SELECT created_at FROM transcript_segments x WHERE x.project_id=t.project_id AND x.transcript_id=t.transcript_id
          UNION ALL SELECT created_at FROM raw_archive_refs r WHERE r.project_id=t.project_id AND r.transcript_id=t.transcript_id
            AND r.source_kind='transcript' AND r.disposition='archived')),t.transcript_id)-1,
      COALESCE(p.start_offset,0),COALESCE(p.start_offset,0),
      CASE WHEN p.start_offset>0 THEN '{"mycoParserViewCheckpoint":1,"mycoParserMeta":null,"mycoParserState":{}}' END,
      NULL,CASE WHEN p.start_offset>0 THEN 1 ELSE 0 END,?
    FROM transcripts t LEFT JOIN previous p ON p.transcript_id=t.transcript_id WHERE t.project_id=? AND t.session_id=?
      AND NOT EXISTS(SELECT 1 FROM view_checkpoints c WHERE c.project_id=t.project_id AND c.instance_id=? AND c.transcript_id=t.transcript_id)`,
      )
      .bind(project, instance, project, instance, session, project, instance, PARSER_VERSION, project, session, instance),
  ];
}

/** Only converting sessions need the final bounded acknowledgement tail. */
export function legacyAckFeedStatement(
  db: RelationalStore,
  project: string,
  session: string,
  ack: string,
): PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO view_legacy_ack_feed(project_id,session_id,ack_id)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM session_views WHERE project_id=? AND session_id=? AND legacy='converting')
    AND EXISTS(SELECT 1 FROM extraction_acks WHERE project_id=? AND ack_id=?)`,
    )
    .bind(project, session, ack, project, session, project, ack);
}

export async function prepareLegacyCoverageTail(
  db: RelationalStore,
  target: ViewWriteTarget,
  now: number,
): Promise<{ statements: PreparedStatement[]; watermark: number | null; count: number } | null> {
  return prepareLegacyCoverage(db, target, now, 'tail');
}

/** Conversion pages advance only their stable acknowledgement coordinate. */
export async function convertLegacyCoveragePage(
  db: RelationalStore,
  target: ViewWriteTarget,
  now: number,
): Promise<number> {
  const page = await prepareLegacyCoverage(db, target, now, 'page');
  if (page === null || page.watermark === null) return 0;
  await db.batch([
    ...viewWriteGuard(db, target, now),
    ...page.statements,
    db
      .prepare(
        `UPDATE view_build_work SET legacy_ack_watermark=MAX(legacy_ack_watermark,?) WHERE project_id=? AND session_id=?`,
      )
      .bind(page.watermark, target.projectId, target.sessionId),
  ]);
  return page.count;
}

async function prepareLegacyCoverage(db: RelationalStore, target: ViewWriteTarget, now: number, mode: 'page' | 'tail') {
  const selected = (
    await db
      .prepare(
        `SELECT f.ack_seq,f.ack_id FROM view_legacy_ack_feed f JOIN view_build_work w
    ON w.project_id=f.project_id AND w.session_id=f.session_id WHERE f.project_id=? AND f.session_id=? AND f.ack_seq>w.legacy_ack_watermark
    ORDER BY f.ack_seq LIMIT 65`,
      )
      .bind(target.projectId, target.sessionId)
      .all<{ ack_seq: number; ack_id: string }>()
  ).results;
  if (mode === 'tail' && selected.length > FINAL_CONVERSION_LIMIT) return null;
  const feed = selected.slice(0, FINAL_CONVERSION_LIMIT);
  const watermark = feed.at(-1)?.ack_seq ?? null;
  const pairs = (
    await db
      .prepare(
        `SELECT a.ack_id,a.run_id,l.prompt_id legacy_id,l.claim legacy_claim,l.source_key legacy_key,l.source_thread legacy_thread,l.source_record legacy_record,l.prompt_kind legacy_shape,
    (SELECT CASE WHEN COUNT(DISTINCT t.prompt_identity_scheme)=1 THEN MIN(t.prompt_identity_scheme) ELSE 'mixed' END FROM transcripts t WHERE t.project_id=l.project_id AND t.session_id=l.session_id) scheme,
    p.prompt_id,p.claim,p.source_key,p.source_thread,p.source_record,p.prompt_kind,p.canonical_identity,p.source_transcript_id,p.source_offset,p.source_end
    FROM json_each(?) j CROSS JOIN extraction_acks a ON a.project_id=? AND a.ack_id=j.value
    JOIN prompt_batches l ON l.project_id=a.project_id AND l.prompt_id=a.record_id
    JOIN fact_classes f ON f.project_id=l.project_id AND f.table_name='prompt_batches' AND f.record_id=l.prompt_id AND f.class='legacy'
    JOIN view_prompts p ON p.project_id=l.project_id AND p.instance_id=? AND p.prompt_id IN(
      SELECT prompt_id FROM view_prompts INDEXED BY idx_view_prompt_source WHERE project_id=l.project_id AND instance_id=?
        AND claim=l.claim AND source_key=l.source_key AND source_thread=l.source_thread AND source_record=l.source_record
      UNION ALL SELECT l.prompt_id)`,
      )
      .bind(JSON.stringify(feed.map((row) => row.ack_id)), target.projectId, target.instanceId, target.instanceId)
      .all<Record<string, unknown>>()
  ).results;
  const converted = pairs.flatMap((row) => {
    const scheme = String(row.scheme);
    const shape = (kind: unknown): CoverageIdentity['shape'] =>
      kind === 'queued_command' ? 'queued' : scheme === 'stamp-or-offset-v1' ? 'stamped' : undefined;
    const field = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : null);
    const old: CoverageIdentity = {
      id: String(row.legacy_id),
      claim: field('legacy_claim'),
      key: field('legacy_key'),
      thread: field('legacy_thread'),
      record: field('legacy_record'),
      scheme,
      shape: shape(row.legacy_shape),
    };
    const identity = typeof row.canonical_identity === 'string' ? JSON.parse(row.canonical_identity) : null;
    const current: CoverageIdentity = {
      id: String(row.prompt_id),
      claim: field('claim'),
      key: field('source_key'),
      thread: field('source_thread'),
      record: field('source_record'),
      scheme,
      shape:
        row.prompt_kind === 'queued_command'
          ? 'queued'
          : Array.isArray(identity) && identity[2] === 'stamp'
            ? 'stamped'
            : undefined,
    };
    return carriesCoverage(old, current)
      ? [
          {
            ack: 'view:' + String(row.ack_id) + ':' + target.instanceId,
            run: row.run_id,
            transcript: row.source_transcript_id,
            start: row.source_offset,
            end: row.source_end,
          },
        ]
      : [];
  });
  return {
    watermark,
    count: feed.length,
    statements: [
      ...(mode === 'tail'
        ? contentAssertion(
            db,
            `(SELECT MAX(f.ack_seq) FROM view_legacy_ack_feed f JOIN view_build_work w ON w.project_id=f.project_id AND w.session_id=f.session_id
    WHERE f.project_id=? AND f.session_id=? AND f.ack_seq>w.legacy_ack_watermark) IS ?`,
            [target.projectId, target.sessionId, watermark],
          )
        : []),
      db
        .prepare(
          `INSERT OR IGNORE INTO extraction_acks(project_id,ack_id,session_id,kind,source_transcript_id,source_offset,source_end,run_id,acknowledged_at)
      SELECT ?,json_extract(value,'$.ack'),?,'source',json_extract(value,'$.transcript'),json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.run'),? FROM json_each(?)`,
        )
        .bind(target.projectId, target.sessionId, now, JSON.stringify(converted)),
    ],
  };
}

function readiness(target: ViewWriteTarget, now: number): { sql: string; params: unknown[] } {
  return {
    sql: `NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=? AND t.session_id=? AND NOT EXISTS(
      SELECT 1 FROM view_checkpoints c WHERE c.project_id=t.project_id AND c.instance_id=? AND c.transcript_id=t.transcript_id))
    AND NOT EXISTS(SELECT 1 FROM view_checkpoints c LEFT JOIN transcripts t ON t.project_id=c.project_id AND t.transcript_id=c.transcript_id
      LEFT JOIN sessions ls ON ls.project_id=t.project_id AND ls.session_id=t.session_id WHERE c.project_id=? AND c.instance_id=? AND (t.transcript_id IS NULL OR t.session_id<>? OR c.parsed_offset<>t.size OR c.parse_error IS NOT NULL
        OR ${viewTerminalSql('c', 't', 'ls')}))
    AND NOT EXISTS(SELECT 1 FROM plan_promotions WHERE project_id=? AND session_id=? AND state='pending')
    AND EXISTS(SELECT 1 FROM session_views s JOIN view_build_work w ON w.project_id=s.project_id AND w.session_id=s.session_id
      WHERE s.project_id=? AND s.session_id=? AND
        (SELECT COUNT(*) FROM (SELECT ack_seq FROM view_legacy_ack_feed f WHERE f.project_id=s.project_id AND f.session_id=s.session_id
          AND f.ack_seq>w.legacy_ack_watermark ORDER BY ack_seq LIMIT 65))<=?)
    AND NOT EXISTS(SELECT 1 FROM view_instances i JOIN view_instances p ON p.project_id=i.project_id AND p.instance_id=i.parent_instance
      WHERE i.project_id=? AND i.instance_id=? AND p.state<>'frozen')`,
    params: [
      target.projectId,
      target.sessionId,
      target.instanceId,
      target.projectId,
      target.instanceId,
      target.sessionId,
      ...viewTerminalParams(now),
      target.projectId,
      target.sessionId,
      target.projectId,
      target.sessionId,
      FINAL_CONVERSION_LIMIT,
      target.projectId,
      target.instanceId,
    ],
  };
}

export async function viewReady(db: RelationalStore, target: ViewWriteTarget, now: number): Promise<boolean> {
  const ready = readiness(target, now);
  const row = await db
    .prepare(`SELECT CASE WHEN ${ready.sql} THEN 1 ELSE 0 END ready`)
    .bind(...ready.params)
    .first<{ ready: number }>();
  return row?.ready === 1;
}

/** One transaction publishes every material stamp, closure, frontier and session projection. */
export async function tryPublishView(
  db: RelationalStore,
  target: ViewWriteTarget,
  now: number,
  envelope: FlipEnvelope,
  clock = () => performance.now(),
  /** Where the flip's observation is finished; it is never refused by the admission `db` carries. */
  observationDb = db,
): Promise<FlipResult> {
  if (!flipMeasurementAvailable(envelope)) return { published: false, reason: 'view_flip_admission_unavailable' };
  const started = clock(),
    limits = remainingContentBudget(db),
    measured = measuredContentEnv(
      { db },
      { ...limits, enforceWall: true, wallMs: Math.min(limits.wallMs, CONTENT_WALL_MS) },
    );
  db = measured.env.db;
  if (await flipCalibrationBlocked(db, envelope, now))
    return { published: false, reason: 'view_flip_admission_unavailable' };
  if (!(await viewReady(db, target, now))) return { published: false, reason: 'view_not_ready' };
  const work = await readFlipWork(db, target);
  const count = VIEW_MATERIALS.reduce((sum, material) => sum + work['candidate_' + material.kind + '_rows']!, 0);
  if (!flipWorkFits(work, envelope)) return { published: false, reason: 'view_flip_content_wall_exceeded' };
  const tail = await prepareLegacyCoverageTail(db, target, now);
  if (tail === null) return { published: false, reason: 'view_not_ready' };
  const attempt = crypto.randomUUID(),
    ready = readiness(target, now);
  const writes = [
    ...viewWriteGuard(db, target, now),
    ...contentAssertion(db, ready.sql, ready.params),
    ...flipWorkGuard(db, target, envelope),
    ...flipContentGuard(db, target),
    ...beginFlipObservation(db, envelope, attempt, now),
    ...viewPlanTransitionStatements(db, target),
    ...tail.statements,
    ...publicationVersionStatements(
      db,
      target.projectId,
      target.sessionId,
      attempt,
      { instanceId: target.instanceId },
      true,
    ),
    ...stampVersionStatements(db, target, attempt),
    db
      .prepare(
        `UPDATE view_instances SET state='retired',retired_at=? WHERE project_id=? AND instance_id=? AND base<>'frozen'`,
      )
      .bind(now, target.projectId, target.liveInstance),
    db
      .prepare(
        `UPDATE view_instances SET state='live',published_at=?,lease_token=NULL,lease_expires_at=NULL WHERE project_id=? AND instance_id=?`,
      )
      .bind(now, target.projectId, target.instanceId),
    db
      .prepare(
        `UPDATE session_views SET live_instance=?,building_instance=NULL,fence=fence+1,legacy='published',rebuild_state='idle',failures=0,last_failure=NULL,next_attempt_at=NULL,updated_at=? WHERE project_id=? AND session_id=?`,
      )
      .bind(target.instanceId, now, target.projectId, target.sessionId),
    db.prepare(`DELETE FROM view_visible WHERE project_id=? AND session_id=?`).bind(target.projectId, target.sessionId),
    db
      .prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,?,'live',0)`)
      .bind(target.projectId, target.instanceId, target.sessionId),
    db
      .prepare(
        `INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence)
      SELECT project_id,parent_instance,session_id,'parent',1 FROM view_instances WHERE project_id=? AND instance_id=? AND parent_instance IS NOT NULL`,
      )
      .bind(target.projectId, target.instanceId),
    ...liveFrontierMirrorStatements(db, target),
    ...viewSessionProjectionStatements(db, target),
    db
      .prepare(`DELETE FROM view_legacy_ack_feed WHERE project_id=? AND session_id=?`)
      .bind(target.projectId, target.sessionId),
    ...publishViewSample(db, target, now),
    db
      .prepare(`DELETE FROM view_build_work WHERE project_id=? AND session_id=?`)
      .bind(target.projectId, target.sessionId),
    ...finishVersionStatements(db, target.projectId, target.sessionId, attempt),
  ];
  const statements = writes.length + measured.usage.statements + 1;
  if (
    statements > envelope.measurement!.statements ||
    measured.usage.roundTrips + 2 > envelope.measurement!.roundTrips ||
    clock() - started > CONTENT_WALL_MS
  )
    return { published: false, reason: 'view_flip_content_wall_exceeded' };
  // A flip within the envelope that this invocation's remaining statements cannot hold fits a fresh allowance.
  if (statements > limits.statements) return { published: false, reason: 'view_flip_budget_exhausted' };
  let result;
  try {
    result = await db.batch(writes);
  } catch (error) {
    if (!(error instanceof Error) || !/CHECK constraint failed.*ok\s*=\s*1/i.test(error.message)) throw error;
    if (!(await viewWriteOwned(db, target, now)) || !(await viewReady(db, target, now)))
      return { published: false, reason: 'view_not_ready' };
    const latest = await db
      .prepare(
        `SELECT COUNT(*) n,MAX(f.ack_seq) watermark FROM view_legacy_ack_feed f JOIN view_build_work w
      ON w.project_id=f.project_id AND w.session_id=f.session_id WHERE f.project_id=? AND f.session_id=? AND f.ack_seq>w.legacy_ack_watermark`,
      )
      .bind(target.projectId, target.sessionId)
      .first<{ n: number; watermark: number | null }>();
    if (latest?.watermark !== tail.watermark) return { published: false, reason: 'view_not_ready' };
    if ((latest?.n ?? 0) > FINAL_CONVERSION_LIMIT) return { published: false, reason: 'view_not_ready' };
    if (await flipCalibrationBlocked(db, envelope, now))
      return { published: false, reason: 'view_flip_admission_unavailable' };
    if (!flipWorkFits(await readFlipWork(db, target), envelope, false))
      return { published: false, reason: 'view_flip_content_wall_exceeded' };
    throw error;
  }
  const wallMs = clock() - started;
  await finishFlipObservation(observationDb, envelope, attempt, wallMs, work, measured.usage, result);
  return { published: true, rows: count, wallMs, overrun: wallMs > CONTENT_WALL_MS };
}
