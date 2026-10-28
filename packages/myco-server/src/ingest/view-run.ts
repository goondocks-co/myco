import type { ServerEnv, JobBudget, RelationalStore } from '../core/adapters.js';
import {
  measuredContentEnv,
  remainingInvocationBudget,
  CONTENT_WAKE_JOB_RESERVE,
  CONTENT_BLOB_LIMIT,
  type ContentUsage,
} from '../core/content-budget.js';
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
  /** The build lane takes everything the live lane leaves in this wake. */
  cutover?: boolean;
  /** Only published sessions are extended; no build or rebuild request runs. */
  buildPaused?: boolean;
  /** False while the legacy parser owns the transcript frontier. */
  mirrorFrontier?: boolean;
  /** The build lane reads under its own wall rather than the enclosing wake's content wall. */
  ownWall?: boolean;
  /** Sessions a cutover run builds side by side, each under its own claim; one when absent. */
  inFlight?: number;
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
  if (!options.buildPaused) for (const row of stale) await requestViewRebuild(db, row.project_id, row.session_id, now);
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
      mirrorFrontier: options.mirrorFrontier,
    };
    const report = await parseViewOnce(measured.env, target, now, {
      calls: Math.floor(options.profile.calls / 2),
      deadline: started + Math.floor(options.profile.wallMs / 2),
      clock,
    });
    changed += report?.derived ?? 0;
  }
  const inFlight = options.cutover ? Math.max(1, options.inFlight ?? 1) : 1,
    /** What each session in flight keeps back to release its claim and record its sample. */
    closingStatements = 40 * inFlight;
  const share = live === null ? 2 : 4,
    startCalls = calls(),
    startStatements = measured.usage.statements,
    buildStart = clock();
  const invocation = remainingInvocationBudget(db);
  const budget = options.cutover
    ? {
        calls: Math.max(0, options.profile.calls - calls() - 10),
        statements: Math.max(
          0,
          Math.min(
            WAKE_JOB_STATEMENT_LIMIT - measured.usage.statements,
            invocation === null ? Infinity : invocation.statements - CONTENT_WAKE_JOB_RESERVE,
          ) - closingStatements,
        ),
        wall: Math.max(0, deadline - clock()),
      }
    : {
        calls: Math.floor(options.profile.calls / share),
        statements: Math.floor(WAKE_JOB_STATEMENT_LIMIT / share),
        wall: Math.floor(options.profile.wallMs / share),
      };
  const lane = measuredContentEnv(measured.env, {
    statements: budget.statements,
    blobCalls: options.cutover
      ? Math.max(
          0,
          Math.min(
            WAKE_JOB_BLOB_LIMIT - measured.usage.blobCalls,
            invocation === null ? Infinity : invocation.blobCalls - CONTENT_BLOB_LIMIT,
          ),
        )
      : Math.floor(WAKE_JOB_BLOB_LIMIT / share),
    enforceWall: true,
    wallMs: budget.wall,
    calls: budget.calls,
    ownWall: options.ownWall === true,
  });
  const buildDeadline = Math.min(deadline, buildStart + budget.wall);
  const within = () =>
    calls() - startCalls < budget.calls &&
    measured.usage.statements - startStatements < budget.statements &&
    clock() < buildDeadline;
  const admitted = () => {
    const left = remainingInvocationBudget(db);
    return !left || left.statements >= closingStatements + (options.cutover ? CONTENT_WAKE_JOB_RESERVE : 0);
  };
  const exhausted = (error: unknown) =>
    error instanceof Error && /^content_(?:statement|blob|call|wall)_budget_exhausted$/.test(error.message);
  /** Releasing a claim and recording its sample run in this job's admission, or in the enclosing one once this job's own has run out. */
  const settle = async <T>(admitted: RelationalStore, work: (store: RelationalStore) => Promise<T>): Promise<T> => {
    try {
      return await work(admitted);
    } catch (error) {
      if (!exhausted(error)) throw error;
      return work(env.db);
    }
  };
  /** Runs `work` once every earlier call through the same turn has settled. */
  const oneAtATime = () => {
    let held: Promise<unknown> = Promise.resolve();
    return <T>(work: () => Promise<T>): Promise<T> => {
      const turn = held.then(work);
      held = turn.catch(() => undefined);
      return turn;
    };
  };
  // A publication holds the store's flip observation from its first batch to its last, so sessions built side by side
  // publish one at a time.
  const publishing = oneAtATime(),
    claiming = oneAtATime();
  const samples: {
    target: ViewWriteTarget;
    token: string;
    usage: ContentUsage[];
    started: number;
    serviceMs: number;
    refusal: string | null;
  }[] = [];
  /**
   * Builds one claimed session until it publishes or the lane's admission ends; answers whether it published. Its own
   * calls are counted apart, so sessions built side by side each keep their own sample.
   */
  const serve = async (target: ViewWriteTarget, first: boolean): Promise<boolean> => {
    const targetStart = clock(),
      actualBuildStarted = performance.now(),
      held = measuredContentEnv(measured.env),
      building = measuredContentEnv(lane.env);
    let token: string | null = null,
      refusal: string | null = null,
      done = false;
    try {
      token = await beginViewSample(
        held.env.db,
        target,
        env.platform.name === 'bun' ? 'native' : 'remote',
        options.profile.slots === 2 ? 'parallel' : 'serial',
        now,
      );
      while (within() && admitted()) {
        const report = await parseViewOnce(building.env, target, now, {
          calls: budget.calls - (calls() - startCalls),
          deadline: buildDeadline,
          clock,
        });
        changed += report?.derived ?? 0;
        // A pass that stopped short of the held bytes leaves more to read; publication waits for one that reached them.
        if (report !== null && report.failure === null && report.unread > 0) continue;
        const flip = await publishing(() =>
          tryPublishView(building.env.db, target, now, {
            ...options.envelope,
            store: env.platform.name === 'bun' ? 'native' : 'remote',
            profile: options.profile.slots === 2 ? 'parallel' : 'serial',
          }),
        );
        if (flip.published) {
          published++;
          done = true;
          break;
        }
        refusal = flip.reason === 'view_not_ready' ? null : flip.reason;
        if (report === null || report.failure !== null) break;
      }
    } catch (error) {
      if (!exhausted(error)) throw error;
    } finally {
      const lease = await settle(held.env.db, (store) =>
        store
          .prepare(`SELECT state,lease_token FROM view_instances WHERE project_id=? AND instance_id=?`)
          .bind(target.projectId, target.instanceId)
          .first<{ state: string; lease_token: string | null }>(),
      );
      if (lease?.state === 'building' && lease.lease_token === target.leaseToken) {
        await settle(held.env.db, (store) => yieldViewBuild(store, target, Math.max(0, clock() - targetStart), now));
        await settle(held.env.db, (store) => releaseViewBuild(store, target, now));
      }
      if (token !== null)
        samples.push({
          target,
          token,
          usage: [held.usage, building.usage],
          started: first ? actualStarted : actualBuildStarted,
          serviceMs: performance.now() - actualBuildStarted,
          refusal,
        });
    }
    return done;
  };
  const claimProfile = { ...options.profile, slots: Math.max(options.profile.slots, inFlight) };
  let first = true;
  /** One selection and claim at a time: a session is offered to the next lane only once the last claim has landed. */
  const claimNext = (): Promise<{ target: ViewWriteTarget | null; first: boolean }> =>
    claiming(async () => {
      const opening = first;
      first = false;
      try {
        const selected = await selectViewBuild(lane.env.db, now);
        const claimed = selected
          ? await claimViewBuild(lane.env.db, selected.project_id, selected.session_id, claimProfile, now)
          : null;
        return { target: claimed ? { ...claimed, mirrorFrontier: options.mirrorFrontier } : null, first: opening };
      } catch (error) {
        if (opening || !exhausted(error)) throw error;
        return { target: null, first: opening };
      }
    });
  // A cutover lane takes the next session once one publishes; any other run builds one session.
  const buildLane = async () => {
    while (!options.buildPaused && (first || options.cutover) && within() && admitted()) {
      const next = await claimNext();
      if (next.target === null || !(await serve(next.target, next.first))) return;
    }
  };
  const lanes = await Promise.allSettled(Array.from({ length: inFlight }, buildLane));
  const failed = lanes.find((settled) => settled.status === 'rejected');
  if (failed) throw failed.reason;
  const remaining = Math.max(0, options.profile.calls - calls() - 10);
  if (options.importWork && remaining > 0 && clock() < deadline) {
    const report = await options.importWork(measured.env, {
      calls: remaining,
      wallMs: Math.max(0, deadline - clock()),
    });
    changed += report.changed;
  }
  // Each sample holds its session's own calls; the first also holds the run's calls outside every session.
  const sum = (usages: ContentUsage[]) => ({
    statements: usages.reduce((total, usage) => total + usage.statements, 0),
    roundTrips: usages.reduce((total, usage) => total + usage.roundTrips, 0),
    blobCalls: usages.reduce((total, usage) => total + usage.blobCalls, 0),
  });
  const owned = sum(samples.flatMap((sample) => sample.usage)),
    shared = { ...measured.usage };
  for (const [index, sample] of samples.entries()) {
    const own = sum(sample.usage);
    await settle(db, (store) =>
      finishViewSample(
        store,
        sample.target,
        sample.token,
        index === 0
          ? {
              statements: own.statements + shared.statements - owned.statements,
              roundTrips: own.roundTrips + shared.roundTrips - owned.roundTrips,
              blobCalls: own.blobCalls + shared.blobCalls - owned.blobCalls,
            }
          : own,
        performance.now() - sample.started,
        sample.serviceMs,
        sample.refusal,
      ),
    );
  }
  return { changed, published, usage: measured.usage, wallMs: clock() - started };
}
