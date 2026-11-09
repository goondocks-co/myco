import { TITLING_MAX_ATTEMPTS, TITLING_REFRESH_MIN_INTERVAL_MS, TITLING_REFRESH_MIN_PROMPTS, SESSION_END_SETTLE_MS } from '../../constants.js';
import type { RelationalStore } from '../../core/adapters.js';
import { RUN_OVERRUN_MARGIN_MS } from '../../core/run-deadline.js';
import { jsonKeys } from '../ddl.js';
import { commitNamed, first, read, readSet, rows, write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';
import { notTombstonedSql, titleRunInFlightSql } from '../session-read-model.js';
import { sessionMaterialReadySql } from './material.js';

/** How long a titling run may take. The task definition says the same (`title-summary.yaml`); this is the bound the claim's in-flight window is computed from. */
export const TITLING_RUN_TIMEOUT_SECONDS = 300;
/** How long after an owner's ask a second ask is refused: the run's own bound plus the overrun margin, so a run still writing is never raced by a second one. */
export const OWNER_TITLING_WINDOW_MS = TITLING_RUN_TIMEOUT_SECONDS * 1000 + RUN_OVERRUN_MARGIN_MS;

/**
 * The title work of a session: at most one `claim` row (a first title is owed) and one `refresh` row (a standing title
 * has fallen behind), kept by triggers on the session's own columns and its live document. A row sleeps on a deadline or
 * a condition; a promotion reads the rows now due and decides, in one statement, whether each is ready or sleeps again.
 * A pass then takes ready rows in the order they are titled, so what it reads does not grow with the sessions held.
 * Everything a promotion decides is read fresh: a trigger records only that a row should be looked at.
 */
const TITLE_WORK_PROJECTION = 'session_title_work';
const TITLE_WORK_PHASE = 'titleWork';

/** Rows one promotion looks at, per kind of wait. */
export const TITLE_WORK_PROMOTE_PAGE = 100;
/** The first wait of a row whose material or run is not settled; doubles with each look, up to 16 of these. */
export const TITLE_WORK_RECHECK_MS = 300_000;

type ModeName = 'claim' | 'refresh';

const recheckAfter = (now: string, checks: string) => `${now}+${TITLE_WORK_RECHECK_MS}*(1<<MIN(${checks},4))`;

const IMPORTED_SESSION = `(EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)
  AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id=s.project_id AND t.session_id=s.session_id AND t.imported_at IS NULL))`;
const REQUEST_PENDING = 's.ended_at IS NOT NULL AND s.titled_at IS NULL AND s.titling_requested_at IS NOT NULL';
const MATERIAL_HELD = 'COALESCE(d.user_prompts,0)>0';

/** Why a row has no work to hold: its session is gone, deleted, already titled or spent; or, for a refresh, no longer owed. */
const WORK_GONE = `(s.session_id IS NULL OR NOT ${notTombstonedSql('s')} OR CASE k.mode WHEN 'claim'
    THEN s.title IS NOT NULL OR s.titling_attempts>=${TITLING_MAX_ATTEMPTS}
    ELSE s.title IS NULL OR s.titled_at IS NULL OR d.user_prompts IS NULL OR d.user_prompts-COALESCE(d.titled_user_prompts,0)<${TITLING_REFRESH_MIN_PROMPTS} END)`;

/** What a row is waiting for, in the order that decides it: gone, then each condition a session must meet before it is ready. */
const reason = (now: string, idleBefore: string) => `CASE WHEN ${WORK_GONE} THEN 'gone' WHEN k.mode='claim' THEN CASE
    WHEN s.ended_at IS NULL AND s.last_received_at>${idleBefore} THEN 'quiet'
    WHEN ${REQUEST_PENDING} AND s.last_received_at>${now}-${SESSION_END_SETTLE_MS} THEN 'settling'
    WHEN NOT ${MATERIAL_HELD} THEN 'material'
    WHEN NOT ${sessionMaterialReadySql('s')} THEN 'pending'
    WHEN s.titled_at IS NOT NULL AND s.titled_at>=${now}-${OWNER_TITLING_WINDOW_MS} THEN 'retry'
    WHEN s.titled_at IS NOT NULL AND ${titleRunInFlightSql('s')} THEN 'inflight'
    ELSE 'ready' END
  ELSE CASE
    WHEN s.titled_at>${now}-${TITLING_REFRESH_MIN_INTERVAL_MS} THEN 'interval'
    WHEN s.last_received_at<=COALESCE(s.title_material_at,s.titled_at) THEN 'caught_up'
    WHEN NOT ${sessionMaterialReadySql('s')} THEN 'pending'
    WHEN ${titleRunInFlightSql('s')} THEN 'inflight'
    ELSE 'ready' END END`;

const SOURCES = (keys: string) => `FROM (${keys}) k
  LEFT JOIN sessions s ON s.project_id=k.project_id AND s.session_id=k.session_id
  LEFT JOIN session_documents d ON d.project_id=k.project_id AND d.session_id=k.session_id AND d.state='live'
  LEFT JOIN session_title_work w ON w.project_id=k.project_id AND w.session_id=k.session_id AND w.mode=k.mode`;

/** Removes the keys' rows whose session no longer owes them anything: the cheap half of the decision, so the rest of a page is never read twice. */
const dropSql = (keys: string) => `DELETE FROM session_title_work WHERE (project_id,session_id,mode) IN (
  SELECT k.project_id,k.session_id,k.mode ${SOURCES(keys)} WHERE ${WORK_GONE})`;

/**
 * Settles each of the keys: ready at its rank in its cohort, or asleep until what it waits for. A row that has waited
 * on unsettled material or a run looks again sooner the first times and later the more it finds the same; a row a
 * trigger re-arms starts over.
 */
const upsertSql = (keys: string, now: string, idleBefore: string) => `INSERT INTO session_title_work(project_id,session_id,mode,ready,waits,due_at,rank_at,cohort,checks)
  SELECT project_id,session_id,mode,why='ready',
    CASE why WHEN 'quiet' THEN 'quiet' WHEN 'material' THEN 'material' ELSE 'timer' END,
    CASE why WHEN 'quiet' THEN last_received_at WHEN 'material' THEN 0 WHEN 'settling' THEN last_received_at+${SESSION_END_SETTLE_MS}
      WHEN 'retry' THEN titled_at+${OWNER_TITLING_WINDOW_MS}+1 WHEN 'interval' THEN titled_at+${TITLING_REFRESH_MIN_INTERVAL_MS}
      WHEN 'ready' THEN 0 ELSE ${recheckAfter(now, 'checks')} END,
    rank_at,cohort,CASE WHEN why IN ('pending','inflight','caught_up') THEN checks+1 ELSE 0 END
  FROM (SELECT k.project_id,k.session_id,k.mode,${reason(now, idleBefore)} AS why,s.last_received_at,s.titled_at,COALESCE(w.checks,0) AS checks,
      CASE WHEN k.mode='refresh' THEN s.last_received_at WHEN ${REQUEST_PENDING} THEN s.titling_requested_at ELSE COALESCE(s.ended_at,s.last_received_at) END AS rank_at,
      CASE WHEN k.mode='refresh' THEN 'live' WHEN ${REQUEST_PENDING} THEN 'requested' WHEN s.titling_requested_at IS NULL AND ${IMPORTED_SESSION} THEN 'imported' ELSE 'live' END AS cohort
    ${SOURCES(keys)})
  WHERE why<>'gone'
  ON CONFLICT(project_id,session_id,mode) DO UPDATE SET ready=excluded.ready,waits=excluded.waits,due_at=excluded.due_at,
    rank_at=excluded.rank_at,cohort=excluded.cohort,checks=excluded.checks`;

const dueArm = (wait: 'timer' | 'quiet', bound: string, page: string, order: string) => `SELECT * FROM (SELECT project_id,session_id,mode FROM session_title_work INDEXED BY idx_session_title_work_due
    WHERE ready=0 AND waits='${wait}' AND due_at<=${bound} ORDER BY ${order} LIMIT ${page})`;
/** The rows due now: a timer's deadline has passed, or a quiet session's last receipt is at or before the idle bound. Slots: now, idle bound, page. */
const DUE_KEYS = `${dueArm('timer', '?1', '?3', 'due_at,project_id,session_id,mode')} UNION ALL ${dueArm('quiet', '?2', '?3', 'due_at DESC,project_id DESC,session_id DESC,mode DESC')}`;

const dropDue = write<[now: number, idleBefore: number, page: number]>({ name: 'titleWork.dropDue', sql: dropSql(DUE_KEYS) });
const promoteDue = write<[now: number, idleBefore: number, page: number]>({ name: 'titleWork.promoteDue', sql: upsertSql(DUE_KEYS, '?1', '?2') });

const pageKeys = `SELECT project_id,session_id,mode.value AS mode FROM (${jsonKeys(['project_id', 'session_id'])}) JOIN (SELECT 'claim' AS value UNION ALL SELECT 'refresh') mode`;
const dropPage = write<[keys: string]>({ name: 'titleWork.dropPage', sql: dropSql(pageKeys) });
const seedPage = write<[keys: string, now: number, idleBefore: number]>({ name: 'titleWork.seedPage', sql: upsertSql(pageKeys, '?2', '?3') });

const clearRows = write<[]>({ name: 'titleWork.clearRows', sql: 'DELETE FROM session_title_work' });
const clearCounts = write<[]>({ name: 'titleWork.clearCounts', sql: 'DELETE FROM session_title_work_counts' });

/** The seed walks every session key, settling each row as a promotion would; a quiet open session waits for a wake to read the idle bound. */
export const TITLE_WORK_CATCHUP = {
  projection: TITLE_WORK_PROJECTION,
  phases: { [TITLE_WORK_PHASE]: {
    source: { table: 'sessions', columns: ['project_id', 'session_id'], unique: true },
    reconcile: [dropPage, { bindAt: (keys: string, now: number) => seedPage.bind(keys, now, 0) }],
  } },
  reset: () => [clearRows.bind(), clearCounts.bind()],
} as const satisfies CatchupFamily;

type WorkCohort = 'live' | 'imported';

const readyFresh = read<[mode: ModeName, cohort: string, freshAfter: number, limit: number], { projectId: string; sessionId: string; at: number }>({ name: 'titleWork.readyFresh',
  sql: `SELECT project_id AS projectId,session_id AS sessionId,rank_at AS at FROM session_title_work INDEXED BY idx_session_title_work_ready
    WHERE ready=1 AND mode=?1 AND cohort=?2 AND rank_at>=?3 ORDER BY rank_at DESC,project_id,session_id LIMIT ?4` });
const readyBacklog = read<[mode: ModeName, cohort: string, freshAfter: number, limit: number], { projectId: string; sessionId: string; at: number }>({ name: 'titleWork.readyBacklog',
  sql: `SELECT project_id AS projectId,session_id AS sessionId,rank_at AS at FROM session_title_work INDEXED BY idx_session_title_work_ready
    WHERE ready=1 AND mode=?1 AND cohort=?2 AND rank_at<?3 ORDER BY rank_at DESC,project_id,session_id LIMIT ?4` });
const readyRequests = read<[limit: number], { projectId: string; sessionId: string }>({ name: 'titleWork.readyRequests',
  sql: `SELECT project_id AS projectId,session_id AS sessionId FROM session_title_work INDEXED BY idx_session_title_work_ready
    WHERE ready=1 AND mode='claim' AND cohort='requested' ORDER BY rank_at,project_id DESC,session_id DESC LIMIT ?1` });

/** A session the titling convergence may take next: a first title (`claim`) or a refresh of the one standing (`refresh`), with the instant its recency is ranked by. */
export interface TitleCandidate { projectId: string; sessionId: string; mode: ModeName; at: number }
/** The instants that decide which sessions a pass may take, and which cohorts it admits. */
export interface TitleWindow {
  now: number;
  /** A session still open whose last receipt is at or before this counts as ended. */
  idleBefore: number;
  /** A session whose latest activity or end is at or after this is fresh work; an earlier one is backlog, and takes no refresh. */
  freshAfter: number;
  /** Whether wholly imported sessions are admitted. */
  imported: boolean;
}
/** Candidates in the order the convergence takes them: first titles before refreshes, and fresh work before backlog within each. */
export interface TitleCandidates { freshClaims: TitleCandidate[]; freshRefreshes: TitleCandidate[]; backlogClaims: TitleCandidate[] }

const promote = (window: Pick<TitleWindow, 'now' | 'idleBefore'>) => ({
  dropped: dropDue.bind(window.now, window.idleBefore, TITLE_WORK_PROMOTE_PAGE),
  promoted: promoteDue.bind(window.now, window.idleBefore, TITLE_WORK_PROMOTE_PAGE),
});

const newest = (rows: TitleCandidate[], limit: number) =>
  rows.sort((a, b) => b.at - a.at || a.projectId.localeCompare(b.projectId) || a.sessionId.localeCompare(b.sessionId)).slice(0, limit);

/** Up to `limit` candidates of each kind, newest first, after promoting what has fallen due: the sessions a pass decides over. */
export async function takeTitleCandidates(db: RelationalStore, window: TitleWindow, limit: number): Promise<TitleCandidates> {
  const importedCohort: WorkCohort | 'none' = window.imported ? 'imported' : 'none';
  const picked = await commitNamed(db, {
    ...promote(window),
    freshLive: readyFresh.bind('claim', 'live', window.freshAfter, limit),
    freshImported: readyFresh.bind('claim', importedCohort, window.freshAfter, limit),
    backlogLive: readyBacklog.bind('claim', 'live', window.freshAfter, limit),
    backlogImported: readyBacklog.bind('claim', importedCohort, window.freshAfter, limit),
    refreshes: readyFresh.bind('refresh', 'live', window.freshAfter, limit),
  });
  const claims = (arm: { results: Omit<TitleCandidate, 'mode'>[] }): TitleCandidate[] => arm.results.map((row) => ({ ...row, mode: 'claim' as const }));
  return {
    freshClaims: newest([...claims(picked.freshLive), ...claims(picked.freshImported)], limit),
    freshRefreshes: picked.refreshes.results.map((row) => ({ ...row, mode: 'refresh' as const })),
    backlogClaims: newest([...claims(picked.backlogLive), ...claims(picked.backlogImported)], limit),
  };
}

/** Live end requests not yet attempted and settled, oldest first, after promoting what has fallen due. */
export async function takeTitleRequests(db: RelationalStore, window: Pick<TitleWindow, 'now' | 'idleBefore'>, limit: number): Promise<{ projectId: string; sessionId: string }[]> {
  const { requests } = await commitNamed(db, { ...promote(window), requests: readyRequests.bind(limit) });
  return requests.results;
}

const defer = write<[now: number, project: string, session: string, mode: ModeName]>({ name: 'titleWork.defer', sql: `
  UPDATE session_title_work SET ready=0,waits='timer',due_at=${recheckAfter('?1', 'checks')},checks=checks+1
  WHERE project_id=?2 AND session_id=?3 AND mode=?4 AND ready=1` });

/** Puts a row a pass found no longer takeable back to sleep, so it never sits at the head of the ready order. */
export async function deferTitleWork(db: RelationalStore, target: { projectId: string; sessionId: string; mode: ModeName }, now: number): Promise<void> {
  await rows(db, defer.bind(now, target.projectId, target.sessionId, target.mode));
}

const counts = read<[], { cohort: string; n: number }>({ name: 'titleWork.counts', sql: 'SELECT cohort,n FROM session_title_work_counts' });
const seeded = read<[], { done: number }>({ name: 'titleWork.seeded', sql: `SELECT done FROM projection_catchup WHERE projection='${TITLE_WORK_PROJECTION}' AND phase='${TITLE_WORK_PHASE}'` });
const freshOwed = read<[freshAfter: number, importedCohort: string], { owed: number }>({ name: 'titleWork.freshOwed', sql: `SELECT EXISTS(
    SELECT 1 FROM session_title_work INDEXED BY idx_session_title_work_ready WHERE ready=1 AND mode='claim' AND cohort='live' AND rank_at>=?1
  ) OR EXISTS(
    SELECT 1 FROM session_title_work INDEXED BY idx_session_title_work_ready WHERE ready=1 AND mode='claim' AND cohort=?2 AND rank_at>=?1
  ) AS owed` });

/** Sessions owed a title and ready for a claim, by whether their own capture or the backfill switch admits them; null while the seed is still building. */
export interface TitleWorkOwed { building: boolean; live: number | null; imported: number | null }

/** What the convergence has left to claim, from the maintained counters. While the seed builds the totals are withheld, never zero. */
export async function titleWorkOwed(db: RelationalStore): Promise<TitleWorkOwed> {
  const [cohorts, phase] = await readSet(db, counts.bind(), seeded.bind());
  if (phase[0]?.done !== 1) return { building: true, live: null, imported: null };
  const of = (cohort: string) => cohorts.find((row) => row.cohort === cohort)?.n ?? 0;
  return { building: false, live: of('live'), imported: of('imported') };
}

/** Whether a first title of fresh work waits to be claimed, for the cohorts a pass admits. */
export async function freshTitleOwed(db: RelationalStore, freshAfter: number, imported: boolean): Promise<boolean> {
  return (await first(db, freshOwed.bind(freshAfter, imported ? 'imported' : 'none')))?.owed === 1;
}

/** Why an ended session carries no title yet, in the order a reader can act on it. */
export type UntitledReason = 'capture_pending' | 'no_material' | 'in_progress' | 'stopped' | 'imported' | 'waiting';
const untitled = read<[project: string, session: string], { reason: UntitledReason | null }>({ name: 'titleWork.untitledReason', sql: `SELECT CASE WHEN s.title IS NOT NULL OR s.ended_at IS NULL THEN NULL
    WHEN NOT ${sessionMaterialReadySql('s')} THEN 'capture_pending'
    WHEN NOT EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id=s.project_id AND d.session_id=s.session_id AND d.state='live' AND d.user_prompts>0) THEN 'no_material'
    WHEN ${titleRunInFlightSql('s')} THEN 'in_progress'
    WHEN s.titling_attempts>=${TITLING_MAX_ATTEMPTS} THEN 'stopped'
    WHEN s.titling_requested_at IS NULL AND ${IMPORTED_SESSION} THEN 'imported'
    ELSE 'waiting' END AS reason FROM sessions s WHERE s.project_id=?1 AND s.session_id=?2` });

/** Why an ended session is untitled; null for a titled or open session, or one the Project does not hold. */
export async function untitledReason(db: RelationalStore, projectId: string, sessionId: string): Promise<UntitledReason | null> {
  return (await first(db, untitled.bind(projectId, sessionId)))?.reason ?? null;
}
