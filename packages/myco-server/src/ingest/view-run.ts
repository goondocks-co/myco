import type { ServerEnv, JobBudget } from '../core/adapters.js';
import { measuredContentEnv, remainingInvocationBudget } from '../core/content-budget.js';
import { WAKE_JOB_STATEMENT_LIMIT, WAKE_JOB_BLOB_LIMIT } from '../core/tick.js';
import { viewTerminalSql, viewTerminalParams } from './view-terminal.js';
import { PARSER_VERSION } from './parse.js';
import {
  claimViewBuild,
  selectViewBuild,
  yieldViewBuild,
  releaseViewBuild,
  type ViewProfile,
} from './view-build-queue.js';
import { requestViewRebuild, tryPublishView, type FlipEnvelope } from './view-lifecycle.js';
import { parseViewOnce } from './view-parse.js';
import type { ViewWriteTarget } from './view-guard.js';
import { beginViewSample, finishViewSample } from './view-work-samples.js';

export interface ViewRunOptions {
  profile: ViewProfile;
  envelope: FlipEnvelope;
  clock?: () => number;
  importWork?: (env: ServerEnv, budget: JobBudget) => Promise<{ changed: number; more: boolean }>;
}

/** View work shares the invocation's measured live, build and import admission. */
export async function runViewParseJob(env: ServerEnv, now: number, options: ViewRunOptions) {
  const actualStarted = performance.now(),
    clock = options.clock ?? Date.now,
    started = clock(),
    deadline = started + options.profile.wallMs;
  const measured = measuredContentEnv(env, {
    statements: WAKE_JOB_STATEMENT_LIMIT,
    blobCalls: WAKE_JOB_BLOB_LIMIT,
    enforceWall: true,
    wallMs: options.profile.wallMs,
    calls: options.profile.calls,
  });
  const db = measured.env.db,
    calls = () => measured.usage.roundTrips + measured.usage.blobCalls;
  const stale = (
    await db
      .prepare(
        `SELECT i.project_id,i.session_id FROM view_instances i INDEXED BY idx_view_stale
    JOIN session_views s ON s.project_id=i.project_id AND s.session_id=i.session_id AND i.instance_id=COALESCE(s.building_instance,s.live_instance)
    WHERE i.parser_version<? AND i.state IN ('live','building','failed') AND i.base<>'frozen'
      AND NOT EXISTS(SELECT 1 FROM view_instances live WHERE live.project_id=s.project_id AND live.instance_id=s.live_instance AND live.parser_version>?)
      AND (s.next_attempt_at IS NULL OR s.next_attempt_at<=?) ORDER BY i.parser_version,i.project_id,i.session_id,i.instance_id LIMIT 4`,
      )
      .bind(PARSER_VERSION, PARSER_VERSION, now)
      .all<{ project_id: string; session_id: string }>()
  ).results;
  for (const row of stale) await requestViewRebuild(db, row.project_id, row.session_id, now);
  const live = await db
    .prepare(
      `SELECT s.project_id,s.session_id,s.live_instance,s.fence FROM session_views s JOIN view_instances i
    ON i.project_id=s.project_id AND i.instance_id=s.live_instance WHERE i.parser_version=? AND i.state='live' AND EXISTS(
      SELECT 1 FROM transcripts t JOIN sessions ls ON ls.project_id=t.project_id AND ls.session_id=t.session_id LEFT JOIN view_checkpoints c ON c.project_id=t.project_id AND c.instance_id=i.instance_id AND c.transcript_id=t.transcript_id
      WHERE t.project_id=s.project_id AND t.session_id=s.session_id AND (c.transcript_id IS NULL OR c.parsed_offset<t.size OR ${viewTerminalSql('c', 't', 'ls')})) ORDER BY s.updated_at LIMIT 1`,
    )
    .bind(PARSER_VERSION, ...viewTerminalParams(now))
    .first<{ project_id: string; session_id: string; live_instance: string; fence: number }>();
  let changed = 0,
    published = 0;
  if (live) {
    const target: ViewWriteTarget = {
      projectId: live.project_id,
      sessionId: live.session_id,
      instanceId: live.live_instance,
      liveInstance: live.live_instance,
      fence: live.fence,
      leaseToken: null,
    };
    const report = await parseViewOnce(measured.env, target, now, {
      calls: Math.floor(options.profile.calls / 2),
      deadline: started + Math.floor(options.profile.wallMs / 2),
      clock,
    });
    changed += report?.derived ?? 0;
  }
  const share = live === null ? 2 : 4,
    startCalls = calls(),
    startStatements = measured.usage.statements,
    buildStart = clock();
  const budget = {
    calls: Math.floor(options.profile.calls / share),
    statements: Math.floor(WAKE_JOB_STATEMENT_LIMIT / share),
    wall: Math.floor(options.profile.wallMs / share),
  };
  const lane = measuredContentEnv(measured.env, {
    statements: budget.statements,
    blobCalls: Math.floor(WAKE_JOB_BLOB_LIMIT / share),
    enforceWall: true,
    wallMs: budget.wall,
    calls: budget.calls,
  });
  const selected = await selectViewBuild(lane.env.db, now);
  const target = selected
    ? await claimViewBuild(lane.env.db, selected.project_id, selected.session_id, options.profile, now)
    : null;
  const actualBuildStarted = performance.now();
  let sampleToken: string | null = null,
    refusal: string | null = null,
    actualServiceMs = 0;
  if (target)
    try {
      sampleToken = await beginViewSample(
        db,
        target,
        env.platform.name === 'bun' ? 'native' : 'remote',
        options.profile.slots === 2 ? 'parallel' : 'serial',
        now,
      );
      while (
        calls() - startCalls < budget.calls &&
        measured.usage.statements - startStatements < budget.statements &&
        clock() < Math.min(deadline, buildStart + budget.wall)
      ) {
        const left = remainingInvocationBudget(db);
        if (left && left.statements < 40) break;
        const report = await parseViewOnce(lane.env, target, now, {
          calls: budget.calls - (calls() - startCalls),
          deadline: Math.min(deadline, buildStart + budget.wall),
          clock,
        });
        changed += report?.derived ?? 0;
        const flip = await tryPublishView(lane.env.db, target, now, {
          ...options.envelope,
          store: env.platform.name === 'bun' ? 'native' : 'remote',
          profile: options.profile.slots === 2 ? 'parallel' : 'serial',
        });
        if (flip.published) {
          published++;
          break;
        }
        refusal = flip.reason === 'view_not_ready' ? null : flip.reason;
        if (report === null || report.failure !== null) break;
      }
    } catch (error) {
      if (!(error instanceof Error) || !/^content_(?:statement|blob|call|wall)_budget_exhausted$/.test(error.message))
        throw error;
    } finally {
      const held = await db
        .prepare(`SELECT state,lease_token FROM view_instances WHERE project_id=? AND instance_id=?`)
        .bind(target.projectId, target.instanceId)
        .first<{ state: string; lease_token: string | null }>();
      if (held?.state === 'building' && held.lease_token === target.leaseToken) {
        await yieldViewBuild(db, target, Math.max(0, clock() - buildStart), now);
        await releaseViewBuild(db, target, now);
      }
      actualServiceMs = performance.now() - actualBuildStarted;
    }
  const remaining = Math.max(0, options.profile.calls - calls() - 10);
  if (options.importWork && remaining > 0 && clock() < deadline) {
    const report = await options.importWork(measured.env, {
      calls: remaining,
      wallMs: Math.max(0, deadline - clock()),
    });
    changed += report.changed;
  }
  if (target && sampleToken !== null)
    await finishViewSample(
      db,
      target,
      sampleToken,
      measured.usage,
      performance.now() - actualStarted,
      actualServiceMs,
      refusal,
    );
  return { changed, published, usage: measured.usage, wallMs: clock() - started };
}
