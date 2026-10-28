/**
 * Stage two of learning, and the progress both stages share: one `learning_sessions` row per session.
 *
 * A session is learned from its cards, never from its raw records. Its due cards are the carded turns not yet
 * covered; a `none` card is covered when it is written. A session falls eligible once it has due cards and no turn
 * waits for its card, and a session whose new cards are all `none` records a completion with reason `no_signal`
 * without a run. A learning run is assigned the session's due cards oldest first, up to one slice; its guarded
 * completion covers exactly those cards whose input is unchanged, acknowledges the prompts they cover, and carries a
 * short handoff to the next slice.
 *
 * This module is the only one whose SQL names `learning_sessions`, apart from the material-version allocator.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { listTurns } from '../read/turns.js';
import { PROMPT_ORIGINS } from '@goondocks/myco-shared/member-protocol';
import { LEARNING_RESUMED_AT } from './learning-pause.js';
import { LEARNING_SLICE_CHARS } from './read-window.js';
import { TURN_QUIET_MS } from './turn-card-rules.js';
import { commitAttributedWrite } from './runs.js';
import { prepareRecordAcknowledgement } from '../read/view-store.js';
import { LEARNING_TOOL } from './tool-catalogue.js';
import { learningEnabledSql } from './settings.js';
export { LEARNING_TOOL };

/**
 * How initialization treats a session with a transcript that #1924 has not published yet: learned now through the
 * read module, or held until its first publication.
 */
export const LEGACY_LIVE_POLICY: 'learn_now' | 'awaiting_publication' = 'awaiting_publication';

export const INIT_DONE_KEY = 'learning.init.done';
const INIT_CURSOR_KEY = 'learning.init.cursor';
/** Sessions one initialization page classifies. */
export const INIT_PAGE = 25;
const TURN_PAGE = 100;
/** A learning session counts as fresh for this long after it became eligible. */
export const FRESH_LEARNING_MS = 86_400_000;
/** How long a claimed learning slice keeps its session out of the eligible set before the claim is presumed lost. */
export const LEARNING_CLAIM_MS = 900_000;
/** Backoff after repeated claims that never completed: 1 h, 6 h, then each 24 h. */
export const LEARNING_BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000] as const;
export const HANDOFF_MAX_BYTES = 4096;
/** The skip a hand start of learning ends with when no session has a due card. */
export const NOTHING_DUE = 'nothing_due';

const RESUMED = `EXISTS (SELECT 1 FROM schema_meta WHERE key = '${LEARNING_RESUMED_AT}')`;
const UNCOVERED = (project: string, session: string) => `(SELECT COUNT(*) FROM turn_cards c INDEXED BY idx_turn_cards_uncovered
  WHERE c.project_id = ${project} AND c.session_id = ${session} AND c.state = 'carded' AND c.covered = 0)`;

/**
 * A session's due count and eligibility, recomputed after any change to its cards. A session with no turn waiting for
 * its card and no due card has finished its learning; when cards were written after its last completion, that is
 * recorded as a completion with reason `no_signal`.
 */
export function sessionProgressStatements(db: RelationalStore, projectId: string, sessionId: string, now: number): PreparedStatement[] {
  const key = [projectId, sessionId];
  return [
    db.prepare(`UPDATE learning_sessions SET due_cards = ${UNCOVERED('learning_sessions.project_id', 'learning_sessions.session_id')}
      WHERE project_id = ? AND session_id = ?`).bind(...key),
    db.prepare(`UPDATE learning_sessions SET
        eligible_at = CASE WHEN init_state = 'ready' AND skipped_by_owner = 0 AND pending_cards = 0 AND due_cards > 0
          THEN COALESCE(eligible_at, ?) ELSE NULL END
      WHERE project_id = ? AND session_id = ?`).bind(now, ...key),
    db.prepare(`UPDATE learning_sessions SET learned_seq = max_seq, last_completed_at = ?,
        last_completed_reason = CASE WHEN last_completed_at = ? AND last_completed_reason = 'completed' THEN 'completed' ELSE 'no_signal' END
      WHERE project_id = ? AND session_id = ? AND init_state = 'ready' AND pending_cards = 0 AND due_cards = 0
        AND EXISTS (SELECT 1 FROM turn_cards c WHERE c.project_id = learning_sessions.project_id AND c.session_id = learning_sessions.session_id
          AND c.state = 'carded' AND c.carded_at > COALESCE(learning_sessions.last_completed_at, -1))`).bind(now, now, ...key),
  ];
}

/** Whether a session still has learning to do: its row is not ready, a turn waits for its card, or a card is due. */
export function learningIncompleteSql(project: string, session: string): string {
  return `NOT EXISTS (SELECT 1 FROM learning_sessions l WHERE l.project_id = ${project} AND l.session_id = ${session}
      AND (l.init_state = 'ready' AND l.pending_cards = 0 AND l.due_cards = 0 OR l.skipped_by_owner = 1))`;
}

/** Whether a run predates the resumption of learning, or learning has not resumed. */
export async function dispatchedBeforeResume(db: RelationalStore, projectId: string, runId: string): Promise<boolean> {
  const later = await db.prepare(`SELECT 1 AS later FROM agent_runs r JOIN schema_meta m ON m.key = ?
    WHERE r.project_id = ? AND r.id = ? AND COALESCE(r.queued_at, r.started_at) >= CAST(m.value AS INTEGER)`)
    .bind(LEARNING_RESUMED_AT, projectId, runId).first();
  return later === null;
}

/** Whether whole-session learning has resumed; the progress hold applies from then on. */
export const LEARNING_RESUMED_SQL = RESUMED;

type SessionClass = 'published' | 'facts' | 'legacy_live';

async function classify(db: RelationalStore, projectId: string, sessionId: string): Promise<SessionClass> {
  const row = await db.prepare(`SELECT
      EXISTS (SELECT 1 FROM session_views WHERE project_id = ? AND session_id = ? AND live_instance IS NOT NULL) AS published,
      EXISTS (SELECT 1 FROM transcripts WHERE project_id = ? AND session_id = ?) AS transcript`)
    .bind(projectId, sessionId, projectId, sessionId).first<{ published: number; transcript: number }>();
  return row!.published === 1 ? 'published' : row!.transcript === 1 ? 'legacy_live' : 'facts';
}

/** The state initialization gives a session of this class; the legacy-live policy is decided here alone. */
export function initStateFor(sessionClass: SessionClass): 'ready' | 'awaiting_publication' {
  return sessionClass === 'legacy_live' && LEGACY_LIVE_POLICY === 'awaiting_publication' ? 'awaiting_publication' : 'ready';
}

/**
 * Make one session ready: each turn it holds without a card row becomes due for its card. Turns are read newest first
 * and the walk stops at the first page that adds none, so a session made ready again reads only its new turns.
 */
async function readySession(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<void> {
  const scope: ReadScope = { projectId };
  let cursor: string | undefined;
  do {
    const page = await listTurns(db, scope, sessionId, { origins: PROMPT_ORIGINS, limit: TURN_PAGE, order: 'DESC', ...(cursor === undefined ? {} : { cursor }) });
    if (page.rows.length === 0) break;
    const added = await db.prepare(`INSERT OR IGNORE INTO turn_cards (project_id, session_id, turn_key, due_at, created_at)
        SELECT ?, ?, json_extract(value, '$.id'), json_extract(value, '$.at') + ?, json_extract(value, '$.at') FROM json_each(?)`)
      .bind(projectId, sessionId, TURN_QUIET_MS, JSON.stringify(page.rows.map((row) => ({ id: row.promptId, at: row.createdAt })))).run();
    if ((added.meta.changes ?? 0) === 0) break;
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  await db.batch([
    db.prepare(`UPDATE learning_sessions SET init_state = 'ready', pending_cards = (SELECT COUNT(*) FROM turn_cards c
        WHERE c.project_id = learning_sessions.project_id AND c.session_id = learning_sessions.session_id AND c.state = 'pending')
      WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId),
    ...sessionProgressStatements(db, projectId, sessionId, now),
  ]);
}

async function initializeSession(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO learning_sessions (project_id, session_id) VALUES (?, ?)`).bind(projectId, sessionId).run();
  const state = initStateFor(await classify(db, projectId, sessionId));
  if (state === 'ready') await readySession(db, projectId, sessionId, now);
  else await db.prepare(`UPDATE learning_sessions SET init_state = ? WHERE project_id = ? AND session_id = ? AND init_state = 'pending'`)
    .bind(state, projectId, sessionId).run();
}

/**
 * Whether initialization still has sessions to classify while learning is on: the walk is unfinished, a session whose
 * first prompt arrived after learning resumed waits in the queue, or a session waits pending.
 */
export async function learningInitPending(db: RelationalStore): Promise<boolean> {
  const row = await db.prepare(`SELECT ${RESUMED} AND ${learningEnabledSql()} AND (NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = ?)
      OR EXISTS (SELECT 1 FROM learning_init_queue)
      OR EXISTS (SELECT 1 FROM learning_sessions INDEXED BY idx_learning_init_pending WHERE init_state <> 'ready' AND init_state = 'pending')) AS pending`)
    .bind(INIT_DONE_KEY).first<{ pending: number }>();
  return row!.pending === 1;
}

/**
 * One bounded initialization pass: queued sessions first, then sessions waiting pending, then the walk over every
 * session, each Project's newest first, one page per call, its cursor committed with the page.
 */
export async function learningInit(env: Pick<ServerEnv, 'db'>, now: number): Promise<{ changed: number; more: boolean }> {
  const { db } = env;
  if (!(await learningInitPending(db))) return { changed: 0, more: false };
  const { results: queued } = await db.prepare(`SELECT project_id AS projectId, session_id AS sessionId FROM learning_init_queue LIMIT ?`)
    .bind(INIT_PAGE).all<{ projectId: string; sessionId: string }>();
  for (const row of queued) {
    await initializeSession(db, row.projectId, row.sessionId, now);
    await db.prepare(`DELETE FROM learning_init_queue WHERE project_id = ? AND session_id = ?`).bind(row.projectId, row.sessionId).run();
  }
  if (queued.length > 0) return { changed: queued.length, more: true };
  const { results: pending } = await db.prepare(`SELECT project_id AS projectId, session_id AS sessionId FROM learning_sessions
    INDEXED BY idx_learning_init_pending WHERE init_state <> 'ready' AND init_state = 'pending' LIMIT ?`).bind(INIT_PAGE).all<{ projectId: string; sessionId: string }>();
  for (const row of pending) await initializeSession(db, row.projectId, row.sessionId, now);
  if (pending.length > 0) return { changed: pending.length, more: true };
  const cursorRow = await db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).bind(INIT_CURSOR_KEY).first<{ value: string }>();
  const cursor = cursorRow === null ? null : JSON.parse(cursorRow.value) as [string, number, string];
  const { results: page } = await db.prepare(`SELECT project_id AS projectId, session_id AS sessionId, last_received_at AS at
    FROM session_read_facts INDEXED BY idx_session_read_activity WHERE has_session = 1 AND tombstoned = 0
      ${cursor === null ? '' : 'AND (project_id > ? OR project_id = ? AND (last_received_at < ? OR last_received_at = ? AND session_id < ?))'}
    ORDER BY project_id, last_received_at DESC, session_id DESC LIMIT ?`)
    .bind(...(cursor === null ? [] : [cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]]), INIT_PAGE)
    .all<{ projectId: string; sessionId: string; at: number }>();
  for (const row of page) await initializeSession(db, row.projectId, row.sessionId, now);
  const last = page.at(-1);
  await db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`)
    .bind(...(page.length < INIT_PAGE ? [INIT_DONE_KEY, String(now)] : [INIT_CURSOR_KEY, JSON.stringify([last!.projectId, last!.at, last!.sessionId])])).run();
  return { changed: page.length, more: page.length === INIT_PAGE };
}

/** One learning slice: the session, the cards it reads, and the progress revision its completion is guarded by. */
export interface LearningAssignment {
  kind: 'learning';
  expectedRevision: number;
  turns: { turnKey: string; inputHash: string }[];
  more: boolean;
  handoff: string | null;
}

/** The project's eligible session with the newest eligibility inside the range, or null. */
export async function learningHead(db: RelationalStore, projectId: string, now: number, fresh: boolean): Promise<string | null> {
  const row = await db.prepare(`SELECT session_id AS sessionId FROM learning_sessions INDEXED BY idx_learning_eligible
    WHERE project_id = ? AND eligible_at <= ? AND eligible_at ${fresh ? '>' : '<='} ? ORDER BY eligible_at DESC LIMIT 1`)
    .bind(projectId, now, now - FRESH_LEARNING_MS).first<{ sessionId: string }>();
  return row?.sessionId ?? null;
}

/** The next slice of a session's due cards, oldest first, or null when none is due. */
export async function buildLearningAssignment(db: RelationalStore, projectId: string, sessionId: string): Promise<LearningAssignment | null> {
  const progress = await db.prepare(`SELECT revision, handoff FROM learning_sessions WHERE project_id = ? AND session_id = ?`)
    .bind(projectId, sessionId).first<{ revision: number; handoff: string | null }>();
  if (progress === null) return null;
  const { results } = await db.prepare(`SELECT turn_key AS turnKey, input_hash AS inputHash, length(card) AS chars FROM turn_cards
    INDEXED BY idx_turn_cards_uncovered WHERE project_id = ? AND session_id = ? AND state = 'carded' AND covered = 0
    ORDER BY created_at, turn_key`).bind(projectId, sessionId).all<{ turnKey: string; inputHash: string; chars: number }>();
  const turns: LearningAssignment['turns'] = [];
  let room = LEARNING_SLICE_CHARS;
  for (const row of results) {
    if (row.chars > room && turns.length > 0) break;
    room -= row.chars;
    turns.push({ turnKey: row.turnKey, inputHash: row.inputHash });
  }
  if (turns.length === 0) return null;
  return { kind: 'learning', expectedRevision: progress.revision, turns, more: turns.length < results.length, handoff: progress.handoff };
}

/** The statement a claim of a slice adds to its batch: the session leaves the eligible set until the claim is presumed lost. */
export function claimLearningStatement(db: RelationalStore, projectId: string, sessionId: string, now: number,
  run: { runId: string; dispatchedBy: string }): PreparedStatement {
  return db.prepare(`UPDATE learning_sessions SET failures = failures + 1,
      eligible_at = ? + CASE WHEN failures = 0 THEN 0 WHEN failures = 1 THEN ? WHEN failures = 2 THEN ? ELSE ? END
    WHERE project_id = ? AND session_id = ? AND eligible_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = learning_sessions.project_id AND r.id = ? AND r.dispatched_by = ?)`)
    .bind(now + LEARNING_CLAIM_MS, ...LEARNING_BACKOFF_MS, projectId, sessionId, run.runId, run.dispatchedBy);
}

export interface LearningCard { turnKey: string; card: string; signal: string; records: string; promptIds: string[] }

/** The assigned cards as they stand, verbatim, with the prompts each covers. */
export async function assignedCards(db: RelationalStore, projectId: string, sessionId: string, assignment: LearningAssignment): Promise<LearningCard[]> {
  const { results } = await db.prepare(`SELECT c.turn_key AS turnKey, c.card, c.signal, c.records FROM json_each(?) j
    JOIN turn_cards c ON c.project_id = ? AND c.session_id = ? AND c.turn_key = json_extract(j.value, '$.turnKey')
      AND c.input_hash = json_extract(j.value, '$.inputHash') AND c.state = 'carded'
    ORDER BY CAST(j.key AS INTEGER)`).bind(JSON.stringify(assignment.turns), projectId, sessionId)
    .all<{ turnKey: string; card: string; signal: string; records: string }>();
  return results.map((row) => ({
    ...row,
    promptIds: (JSON.parse(row.records ?? '[]') as [string, string][]).filter(([kind]) => kind === 'prompt').map(([, id]) => id),
  }));
}

/**
 * Complete a slice in one guarded batch: the progress revision must be the one assigned, and every prompt the slice
 * covers must have been served to this run. The cards whose input is unchanged are covered, their prompts are
 * acknowledged, and the handoff is kept.
 */
export async function completeLearning(
  db: RelationalStore, projectId: string, sessionId: string, runId: string, assignment: LearningAssignment, handoff: string, now: number,
): Promise<{ completed: boolean; covered: number }> {
  const served = await db.prepare(`SELECT record_id AS promptId, MIN(served_id) AS servedId FROM run_served_material
    WHERE project_id = ? AND run_id = ? AND session_id = ? GROUP BY record_id`).bind(projectId, runId, sessionId).all<{ promptId: string; servedId: string }>();
  const servedIds = new Map(served.results.map((row) => [row.promptId, row.servedId]));
  const cards = await assignedCards(db, projectId, sessionId, assignment);
  const prompts = cards.flatMap((card) => card.promptIds);
  if (prompts.some((id) => !servedIds.has(id))) return { completed: false, covered: 0 };
  const turns = JSON.stringify(cards.map((card) => card.turnKey));
  const landed = `EXISTS (SELECT 1 FROM learning_sessions l WHERE l.project_id = ? AND l.session_id = ? AND l.revision = ? AND l.last_completed_at = ?)`;
  const landedParams = [projectId, sessionId, assignment.expectedRevision + 1, now];
  const result = await commitAttributedWrite(db, { projectId },
    db.prepare(`UPDATE learning_sessions SET revision = revision + 1, handoff = ?, last_completed_at = ?, last_completed_reason = 'completed',
        failures = 0, eligible_at = NULL,
        learned_seq = MAX(learned_seq, COALESCE((SELECT MAX(c.last_seq) FROM turn_cards c WHERE c.project_id = ? AND c.session_id = ?
          AND c.turn_key IN (SELECT value FROM json_each(?))), learned_seq))
      WHERE project_id = ? AND session_id = ? AND revision = ?`)
      .bind(handoff, now, projectId, sessionId, turns, projectId, sessionId, assignment.expectedRevision),
    { runId, toolName: LEARNING_TOOL, op: 'complete', recordedAt: now, detail: { session_id: sessionId, cards: cards.length } },
    [
      db.prepare(`UPDATE turn_cards SET covered = 1 WHERE project_id = ? AND session_id = ? AND turn_key IN (SELECT json_extract(value, '$.turnKey') FROM json_each(?))
        AND input_hash = (SELECT json_extract(value, '$.inputHash') FROM json_each(?) WHERE json_extract(value, '$.turnKey') = turn_cards.turn_key) AND ${landed}`)
        .bind(projectId, sessionId, JSON.stringify(assignment.turns), JSON.stringify(assignment.turns), ...landedParams),
      ...prompts.map((promptId) => prepareRecordAcknowledgement(db, projectId, runId, servedIds.get(promptId), servedIds.get(promptId), crypto.randomUUID(), now)),
      ...sessionProgressStatements(db, projectId, sessionId, now),
    ]);
  return { completed: (result.meta.changes ?? 0) > 0, covered: (result.meta.changes ?? 0) > 0 ? cards.length : 0 };
}

/** Counts the status line caps; a count at the cap reads "at least". */
const STATUS_CAP = 1000;
const capped = (inner: string) => `(SELECT COUNT(*) FROM (${inner} LIMIT ${STATUS_CAP + 1}))`;

export interface LearningStatus {
  resumed: boolean;
  dueSessions: number;
  dueCards: number;
  turnsAwaitingCards: number;
  awaitingPublication: number;
  initializing: boolean;
  lastCompleted: { at: number; reason: string; sessionId: string } | null;
  /** Counts at this value are lower bounds. */
  cap: number;
}

/** What learning has due and waiting, Deployment-wide, from the stages' own indexes. */
export async function readLearningStatus(db: RelationalStore): Promise<LearningStatus> {
  const row = await db.prepare(`SELECT ${RESUMED} AS resumed,
      ${capped(`SELECT 1 FROM learning_sessions INDEXED BY idx_learning_eligible_all WHERE eligible_at IS NOT NULL`)} AS dueSessions,
      ${capped(`SELECT 1 FROM turn_cards INDEXED BY idx_turn_cards_uncovered WHERE state = 'carded' AND covered = 0`)} AS dueCards,
      ${capped(`SELECT 1 FROM turn_cards INDEXED BY idx_turn_cards_due_all WHERE state = 'pending'`)} AS turnsAwaitingCards,
      ${capped(`SELECT 1 FROM learning_sessions INDEXED BY idx_learning_init_pending WHERE init_state <> 'ready' AND init_state = 'awaiting_publication'`)} AS awaitingPublication`)
    .first<{ resumed: number; dueSessions: number; dueCards: number; turnsAwaitingCards: number; awaitingPublication: number }>();
  const last = await db.prepare(`SELECT last_completed_at AS at, last_completed_reason AS reason, session_id AS sessionId FROM learning_sessions
    INDEXED BY idx_learning_completed WHERE last_completed_at IS NOT NULL ORDER BY last_completed_at DESC LIMIT 1`).first<{ at: number; reason: string; sessionId: string }>();
  return {
    resumed: row!.resumed === 1, dueSessions: row!.dueSessions, dueCards: row!.dueCards, turnsAwaitingCards: row!.turnsAwaitingCards,
    awaitingPublication: row!.awaitingPublication, initializing: await learningInitPending(db), lastCompleted: last, cap: STATUS_CAP,
  };
}

/** The status line: what is due, what waits and why, the last completion, and spend against the day's budget. */
export function learningStatusLine(status: LearningStatus, budget: { dailyUsd: number; automaticUsd: number | null; manualUsd: number | null } | null, now: number): string {
  if (!status.resumed) return 'Learning is paused until whole-session reading ships.';
  const n = (count: number) => (count > status.cap ? `at least ${status.cap}` : String(count));
  const parts = [
    `${n(status.dueSessions)} sessions due (${n(status.dueCards)} cards to learn)`,
    `${n(status.turnsAwaitingCards)} turns waiting for their card`,
    ...(status.awaitingPublication > 0 ? [`${n(status.awaitingPublication)} sessions waiting for publication`] : []),
    ...(status.initializing ? ['still classifying sessions'] : []),
    status.lastCompleted === null ? 'nothing learned yet'
      : `last ${status.lastCompleted.reason === 'no_signal' ? 'session closed with nothing to learn' : 'slice learned'} ${Math.max(0, Math.round((now - status.lastCompleted.at) / 60_000))} min ago`,
    ...(budget === null || budget.automaticUsd === null ? [] : [`spent $${(budget.automaticUsd + (budget.manualUsd ?? 0)).toFixed(2)} of $${budget.dailyUsd.toFixed(2)} today`]),
  ];
  return `Learning: ${parts.join('; ')}.`;
}
