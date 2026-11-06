import { LEARNING_RETRY_KEY } from '../db/run-context.js';
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
 * Session learning progress and receipt-time claim admission share this per-session row.
 */
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { LEARNING_SLICE_CHARS } from './read-window.js';
import { answerRoom, materialPages, type PagedEntry } from './material-pages.js';
import { commitAttributedWrite } from './runs.js';
import { prepareRecordAcknowledgement } from '../read/catalog-store.js';
import { LEARNING_TOOL } from './tool-catalogue.js';
import { learningEnabledSql, learningHistoryEnabled } from './settings.js';
import { FRESH_LEARNING_MS, freshRetrySql, learningRangeSql, learningRecencySql } from './learning-recency.js';
export { FRESH_LEARNING_MS } from './learning-recency.js';
export { LEARNING_TOOL };

/** Rows of each source-activity repair stream read by one wake. */
export const LEARNING_SOURCE_REPAIR_PAGE = 100;
const SOURCE_REPAIR_STREAMS = [
  { table: 'turn_cards', index: 'idx_turn_cards_source_missing', cursor: 'learning_card_source_after' },
  { table: 'learning_sessions', index: 'idx_learning_source_missing', cursor: 'learning_session_source_after' },
] as const;

/** Repairs source stamps in bounded pages; rows awaiting source publication retain their place on the next traversal. */
export async function repairLearningSources(db: RelationalStore): Promise<{ changed: number; more: boolean }> {
  let changed = 0;
  let more = false;
  for (const { table, index, cursor } of SOURCE_REPAIR_STREAMS) {
    const { results } = await db.prepare(`SELECT rowid AS id FROM ${table} INDEXED BY ${index}
      WHERE source_activity_at IS NULL AND rowid > COALESCE((SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key = ?),0)
      ORDER BY rowid LIMIT ?`).bind(cursor, LEARNING_SOURCE_REPAIR_PAGE).all<{ id: number }>();
    if (results.length === 0) {
      await db.prepare('DELETE FROM schema_meta WHERE key = ?').bind(cursor).run();
      continue;
    }
    const source = `(SELECT d.last_record_at FROM session_documents d
      WHERE d.project_id = ${table}.project_id AND d.session_id = ${table}.session_id)`;
    const full = results.length === LEARNING_SOURCE_REPAIR_PAGE;
    const writes = await db.batch([
      db.prepare(`UPDATE ${table} SET source_activity_at = ${source}
        WHERE rowid IN (SELECT value FROM json_each(?)) AND source_activity_at IS NULL AND ${source} IS NOT NULL RETURNING rowid`)
        .bind(JSON.stringify(results.map(row => row.id))),
      db.prepare('INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)').bind(cursor, String(full ? results.at(-1)!.id : 0)),
    ]);
    const pageChanged = writes[0]!.results.length;
    changed += pageChanged;
    more ||= full && pageChanged > 0;
  }
  return { changed, more };
}

/** Due cards one slice reads at most. */
export const LEARNING_SLICE_CARDS = 200;
/** How long a claimed learning slice keeps its session out of the eligible set before the claim is presumed lost. */
export const LEARNING_CLAIM_MS = 900_000;
/** Backoff after repeated claims that never completed: 1 h, 6 h, then each 24 h. */
export const LEARNING_BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000] as const;
export const HANDOFF_MAX_BYTES = 4096;
/** The skip a hand start of learning ends with when no session has a due card. */
export const NOTHING_DUE = 'nothing_due';

const UNCOVERED = (project: string, session: string) => `(SELECT COUNT(*) FROM turn_cards c INDEXED BY idx_turn_cards_uncovered
  WHERE c.project_id = ${project} AND c.session_id = ${session} AND c.state = 'carded' AND c.covered = 0)`;

/**
 * A session's due count and eligibility, recomputed after any change to its cards. A session with no turn waiting for
 * its card and no due card has finished its learning; when cards were written after its last completion, that is
 * recorded as a completion with reason `no_signal`.
 */
export function sessionProgressStatements(db: RelationalStore, projectId: string, sessionId: string, now: number,
  guard: { sql: string; params: readonly unknown[] } = { sql: '1', params: [] }): PreparedStatement[] {
  const key = [projectId, sessionId];
  return [
    db.prepare(`UPDATE learning_sessions SET due_cards = ${UNCOVERED('learning_sessions.project_id', 'learning_sessions.session_id')}
      WHERE project_id = ? AND session_id = ? AND ${guard.sql}`).bind(...key, ...guard.params),
    db.prepare(`UPDATE learning_sessions SET
        fresh_admitted = CASE WHEN pending_cards = 0 AND due_cards = 0 THEN 0 ELSE fresh_admitted END,
        eligible_at = CASE WHEN init_state = 'ready' AND skipped_by_owner = 0 AND pending_cards = 0 AND due_cards > 0
          THEN COALESCE(eligible_at, ?) ELSE NULL END
      WHERE project_id = ? AND session_id = ? AND ${guard.sql}`).bind(now, ...key, ...guard.params),
    db.prepare(`UPDATE learning_sessions SET learned_seq = max_seq, last_completed_at = ?,
        last_completed_reason = CASE WHEN last_completed_at = ? AND last_completed_reason = 'completed' THEN 'completed' ELSE 'no_signal' END
      WHERE project_id = ? AND session_id = ? AND init_state = 'ready' AND pending_cards = 0 AND due_cards = 0
        AND EXISTS (SELECT 1 FROM turn_cards c WHERE c.project_id = learning_sessions.project_id AND c.session_id = learning_sessions.session_id
          AND c.state = 'carded' AND c.carded_at > COALESCE(learning_sessions.last_completed_at, -1))
        AND ${guard.sql}`).bind(now, now, ...key, ...guard.params),
  ];
}

/** A card or learning assignment must still name a quiet session when its claim commits. */
export function quietSessionClaim(projectId: string, context: Readonly<Record<string, unknown>> | undefined, now: number): { sql: string; params: unknown[] } {
  const assignment = context?.assignment;
  if (typeof context?.session_id !== 'string' || assignment === null || typeof assignment !== 'object'
    || !('kind' in assignment) || !['cards', 'learning'].includes(String(assignment.kind))) return { sql: '1', params: [] };
  return { sql: 'EXISTS (SELECT 1 FROM learning_sessions WHERE project_id = ? AND session_id = ? AND quiet_at <= ?)',
    params: [projectId, context.session_id, now] };
}

/** The statement that gives a published session its learning row, ready. */
export function learningSessionStatement(db: RelationalStore, projectId: string, sessionId: string): PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO learning_sessions (project_id, session_id, init_state, source_activity_at)
    VALUES (?1, ?2, 'ready', (SELECT last_record_at FROM session_documents WHERE project_id = ?1 AND session_id = ?2))`).bind(projectId, sessionId);
}

/** Recounts pending cards for one session. */
export function pendingCardsStatement(db: RelationalStore, projectId: string, sessionId: string): PreparedStatement {
  return db.prepare(`UPDATE learning_sessions SET pending_cards = (SELECT COUNT(*) FROM turn_cards c INDEXED BY idx_turn_cards_session_pending
      WHERE c.project_id = learning_sessions.project_id AND c.session_id = learning_sessions.session_id AND c.state = 'pending') WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId);
}

/** One learning slice: the session, the cards it reads, and the progress revision its completion is guarded by. */
export interface LearningAssignment {
  kind: 'learning';
  expectedRevision: number;
  turns: { turnKey: string; inputHash: string }[];
  more: boolean;
  handoff: string | null;
}

/** Fresh work seeks its two source-day buckets; later source clocks retain their source-ordered range. */
export function learningWorkFrom(project: string, now: number, kind: 'cards' | 'learning', fresh: boolean): string {
  const ready = kind === 'cards' ? 'card_ready_at' : 'learning_ready_at';
  const pending = kind === 'cards' ? 'pending_cards > 0' : 'eligible_at IS NOT NULL';
  const dueIndex = kind === 'cards' ? 'idx_learning_cards_ready' : 'idx_learning_ready';
  if (!fresh) return `learning_sessions l INDEXED BY ${dueIndex}`;
  const freshIndex = kind === 'cards' ? 'idx_learning_cards_fresh' : 'idx_learning_fresh';
  const sourceIndex = kind === 'cards' ? 'idx_learning_source_pending' : 'idx_learning_source_eligible';
  const day = Math.floor(now / FRESH_LEARNING_MS);
  const columns = 'project_id,session_id,source_activity_at,eligible_at,pending_cards,card_ready_at,learning_ready_at,fresh_admitted,card_failures,failures';
  return `(SELECT ${columns} FROM learning_sessions INDEXED BY ${freshIndex}
      WHERE project_id = ${project} AND source_day IN (${day - 1},${day}) AND ${pending} AND ${ready} <= ${Math.floor(now)}
    UNION ALL SELECT ${columns} FROM learning_sessions INDEXED BY ${sourceIndex}
      WHERE project_id = ${project} AND source_activity_at >= ${(day + 1) * FRESH_LEARNING_MS} AND ${pending} AND ${ready} <= ${Math.floor(now)}
    UNION ALL SELECT ${columns} FROM learning_sessions INDEXED BY ${kind === 'cards' ? 'idx_learning_cards_retry' : 'idx_learning_retry'}
      WHERE project_id = ${project} AND ${pending} AND ${freshRetrySql(kind)} AND ${learningRecencySql(false, now)} AND ${ready} <= ${Math.floor(now)}) l`;
}

/** A head reads source order and stops at its first ready session. */
export const learningHeadFrom = (kind: 'cards' | 'learning'): string =>
  `learning_sessions l INDEXED BY ${kind === 'cards' ? 'idx_learning_source_pending' : 'idx_learning_source_eligible'}`;

/** The project's eligible session with the newest source activity inside the range, or null. */
export async function learningHead(db: RelationalStore, projectId: string, now: number, fresh: boolean): Promise<string | null> {
  const row = await db.prepare(`SELECT session_id AS sessionId FROM ${learningHeadFrom('learning')}
    WHERE project_id = ? AND eligible_at IS NOT NULL AND learning_ready_at <= ? AND ${learningRangeSql('learning', fresh, now)} ORDER BY source_activity_at DESC, session_id LIMIT 1`)
    .bind(projectId, now).first<{ sessionId: string }>();
  return row?.sessionId ?? null;
}

/** The next slice of a session's due cards, oldest first, or null when none is due. */
export async function buildLearningAssignment(db: RelationalStore, projectId: string, sessionId: string): Promise<LearningAssignment | null> {
  const progress = await db.prepare(`SELECT revision, handoff FROM learning_sessions WHERE project_id = ? AND session_id = ?`)
    .bind(projectId, sessionId).first<{ revision: number; handoff: string | null }>();
  if (progress === null) return null;
  const { results } = await db.prepare(`SELECT turn_key AS turnKey, input_hash AS inputHash, length(card) AS chars FROM turn_cards
    INDEXED BY idx_turn_cards_uncovered WHERE project_id = ? AND session_id = ? AND state = 'carded' AND covered = 0
    ORDER BY created_at, turn_key LIMIT ?`).bind(projectId, sessionId, LEARNING_SLICE_CARDS + 1).all<{ turnKey: string; inputHash: string; chars: number }>();
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

/** Reserve the session and turn retry state under the claim's canonical attempt. */
export function claimLearningRetryStatement(db: RelationalStore, projectId: string, sessionId: string,
  run: { runId: string; dispatchedBy: string }): PreparedStatement {
  return db.prepare(`UPDATE agent_runs SET run_context = json_set(run_context, '$.${LEARNING_RETRY_KEY}',
      json((SELECT json_object('attemptId', ?, 'failures', failures, 'eligibleAt', eligible_at,
        'cardFailures', card_failures, 'cardRetryAt', card_retry_at, 'revision', revision,
        'turns', json((SELECT json_group_array(json_object('turnKey', turn_key, 'changes', changes, 'dueAt', due_at))
          FROM turn_cards c WHERE c.project_id = l.project_id AND c.session_id = l.session_id AND c.state = 'pending'
            AND c.turn_key IN (SELECT json_extract(value, '$.turnKey') FROM json_each(agent_runs.run_context, '$.assignment.turns')))))
        FROM learning_sessions l WHERE l.project_id = ? AND l.session_id = ?)))
    WHERE project_id = ? AND id = ? AND dispatched_by = ? AND status = 'running'`)
    .bind(run.dispatchedBy, projectId, sessionId, projectId, run.runId, run.dispatchedBy);
}

/** A slice claim holds its session out of the eligible set until completion or lease loss. */
export function claimLearningStatements(db: RelationalStore, projectId: string, sessionId: string, now: number,
  run: { runId: string; dispatchedBy: string }): PreparedStatement[] {
  return [claimLearningRetryStatement(db, projectId, sessionId, run), db.prepare(`UPDATE learning_sessions SET fresh_admitted = CASE WHEN ${learningRecencySql(true, now)} THEN 1 ELSE fresh_admitted END,
      failures = failures + 1,
      eligible_at = ? + CASE WHEN failures = 0 THEN 0 WHEN failures = 1 THEN ? WHEN failures = 2 THEN ? ELSE ? END
    WHERE project_id = ? AND session_id = ? AND eligible_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = learning_sessions.project_id AND r.id = ? AND r.dispatched_by = ?)`)
    .bind(now + LEARNING_CLAIM_MS, ...LEARNING_BACKOFF_MS, projectId, sessionId, run.runId, run.dispatchedBy)];
}

export interface LearningCard { turnKey: string; card: string; signal: string; records: string; promptIds: string[] }

/** The assigned cards as they stand, verbatim, with the prompts each covers. */
export async function assignedCards(db: RelationalStore, projectId: string, sessionId: string, assignment: LearningAssignment): Promise<LearningCard[]> {
  const { results } = await db.prepare(`SELECT c.turn_key AS turnKey, c.card, c.signal, c.records FROM json_each(?) j
    CROSS JOIN turn_cards c ON c.project_id = ? AND c.session_id = ? AND c.turn_key = json_extract(j.value, '$.turnKey')
      AND c.input_hash = json_extract(j.value, '$.inputHash') AND c.state = 'carded'
    ORDER BY CAST(j.key AS INTEGER)`).bind(JSON.stringify(assignment.turns), projectId, sessionId)
    .all<{ turnKey: string; card: string; signal: string; records: string }>();
  return results.map((row) => ({
    ...row,
    promptIds: (JSON.parse(row.records ?? '[]') as [string, string][]).filter(([kind]) => kind === 'prompt').map(([, id]) => id),
  }));
}

/** One card as a learning run reads it. `continues` marks a card that goes on under the same key on the next page. */
export interface LearningMaterial { turn_key: string; signal: string; card: string; continues?: true }

const LEARNING_ENTRY: PagedEntry<LearningMaterial> = {
  textOf: (entry) => entry.card,
  withText: (entry, card, continues) => ({ turn_key: entry.turn_key, signal: entry.signal, card, ...(continues ? { continues: true as const } : {}) }),
};

/** A slice's cards as pages, each an answer the harness holds whole; `opening` is what page 1 carries beside its cards. */
export function learningMaterialPages(sessionId: string, opening: Record<string, unknown>, cards: readonly LearningMaterial[]): LearningMaterial[][] {
  const around = { session_id: sessionId, cards: [] };
  return materialPages(cards, LEARNING_ENTRY, { first: answerRoom({ ...around, ...opening }), rest: answerRoom(around) });
}

/**
 * Complete a slice in one guarded batch: the progress revision must be the one assigned, and every prompt the slice
 * covers must have been served to this run. The cards whose input is unchanged are covered, their prompts are
 * acknowledged, and the handoff is kept. A completion that covers nothing keeps the prior handoff and failure count: it
 * learned nothing a next slice could use, and a session that keeps ending this way must still back off.
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
  const hashes = new Map(assignment.turns.map(turn => [turn.turnKey, turn.inputHash]));
  const assigned = JSON.stringify(cards.map(card => ({ turnKey: card.turnKey, inputHash: hashes.get(card.turnKey) })));
  const surviving = `FROM json_each(?) j CROSS JOIN turn_cards c ON c.turn_key = json_extract(j.value, '$.turnKey')
      AND c.input_hash = json_extract(j.value, '$.inputHash')
    WHERE c.project_id = ? AND c.session_id = ? AND c.state = 'carded'`;
  const coversNothing = `(SELECT COUNT(*) ${surviving}) = 0`;
  const survivingParams = [assigned, projectId, sessionId];
  const landed = `EXISTS (SELECT 1 FROM learning_sessions l WHERE l.project_id = ? AND l.session_id = ? AND l.revision = ? AND l.last_completed_run = ?)`;
  const landedParams = [projectId, sessionId, assignment.expectedRevision + 1, runId];
  const guard = { sql: `${landed} AND NOT (${coversNothing})`, params: [...landedParams, ...survivingParams] };
  const result = await commitAttributedWrite(db, { projectId },
    db.prepare(`UPDATE learning_sessions SET revision = revision + 1, handoff = CASE WHEN ${coversNothing} THEN handoff ELSE ? END,
        last_completed_at = ?, last_completed_run = ?, last_completed_reason = 'completed',
        failures = CASE WHEN ${coversNothing} THEN failures ELSE 0 END,
        eligible_at = CASE WHEN ${coversNothing} THEN eligible_at ELSE NULL END,
        learned_seq = MAX(learned_seq, COALESCE((SELECT MAX(c.last_seq) ${surviving}), learned_seq))
      WHERE project_id = ? AND session_id = ? AND revision = ?
      RETURNING (SELECT COUNT(*) ${surviving}) AS covered`)
      .bind(...survivingParams, handoff, now, runId, ...survivingParams, ...survivingParams, ...survivingParams, projectId, sessionId, assignment.expectedRevision, ...survivingParams),
    { runId, toolName: LEARNING_TOOL, op: 'complete', recordedAt: now, detail: { session_id: sessionId, cards: cards.length } },
    [
      db.prepare(`UPDATE turn_cards SET covered = 1 WHERE state = 'carded' AND project_id = ? AND session_id = ? AND turn_key IN (SELECT json_extract(value, '$.turnKey') FROM json_each(?))
        AND input_hash = (SELECT json_extract(value, '$.inputHash') FROM json_each(?) WHERE json_extract(value, '$.turnKey') = turn_cards.turn_key) AND ${landed}`)
        .bind(projectId, sessionId, assigned, assigned, ...landedParams),
      ...cards.flatMap(card => card.promptIds.map(promptId => prepareRecordAcknowledgement(db, projectId, runId,
        servedIds.get(promptId)!, crypto.randomUUID(), now, {
          sql: `${landed} AND EXISTS (SELECT 1 FROM turn_cards c WHERE c.project_id = ? AND c.session_id = ?
            AND c.turn_key = ? AND c.input_hash = ? AND c.state = 'carded')`,
          params: [...landedParams, projectId, sessionId, card.turnKey, hashes.get(card.turnKey)],
        }))),
      ...sessionProgressStatements(db, projectId, sessionId, now, guard),
    ]);
  const completed = result.results[0] as { covered: number } | undefined;
  return { completed: completed !== undefined, covered: completed?.covered ?? 0 };
}

/** Counts the status line caps; a count at the cap reads "at least". */
const STATUS_CAP = 1000;
const capped = (inner: string) => `(SELECT COUNT(*) FROM (${inner} LIMIT ${STATUS_CAP + 1}))`;

export interface LearningStatus {
  dueSessions: number;
  dueCards: number;
  turnsAwaitingCards: number;
  historyWaiting: number;
  awaitingPublication: number;
  lastCompleted: { at: number; reason: string; sessionId: string } | null;
  /** Counts at this value are lower bounds. */
  cap: number;
}

/** What learning has due and waiting, Deployment-wide, from the stages' own indexes. */
export async function readLearningStatus(db: RelationalStore, now = Date.now()): Promise<LearningStatus> {
  const historyEnabled = await learningHistoryEnabled(db);
  const scopedSessions = (index: string, predicate: string, fresh: boolean) => `FROM projects p CROSS JOIN learning_sessions l INDEXED BY ${index}
    ON l.project_id = p.project_id WHERE ${learningRecencySql(fresh, now)} AND (${predicate})`;
  const waiting = 'pending_cards > 0 OR due_cards > 0';
  const continuing = (kind: 'cards' | 'learning') => `FROM projects p CROSS JOIN learning_sessions l INDEXED BY ${kind === 'cards' ? 'idx_learning_cards_retry' : 'idx_learning_retry'}
    ON l.project_id = p.project_id WHERE ${kind === 'cards' ? 'pending_cards > 0' : 'eligible_at IS NOT NULL'}
      AND ${freshRetrySql(kind)} AND ${learningRecencySql(false, now)}`;
  const freshCount = (column: 'pending_cards' | 'due_cards') => `(SELECT MIN(${STATUS_CAP + 1},COALESCE(SUM(n),0))
    FROM (SELECT ${column} AS n ${scopedSessions(column === 'pending_cards' ? 'idx_learning_source_pending' : 'idx_learning_source_waiting',
      column === 'pending_cards' ? 'pending_cards > 0' : waiting, true)} AND ${column} > 0
      UNION ALL SELECT ${column} AS n ${continuing(column === 'pending_cards' ? 'cards' : 'learning')} AND ${column} > 0 LIMIT ${STATUS_CAP + 1}))`;
  const row = await db.prepare(`SELECT
      ${capped(historyEnabled ? `SELECT 1 FROM projects p CROSS JOIN learning_sessions l INDEXED BY idx_learning_ready ON l.project_id = p.project_id
        WHERE eligible_at IS NOT NULL AND learning_ready_at <= ${Math.floor(now)}`
        : `SELECT 1 ${scopedSessions('idx_learning_source_eligible', `eligible_at IS NOT NULL AND learning_ready_at <= ${Math.floor(now)}`, true)}
          UNION ALL SELECT 1 ${continuing('learning')} AND learning_ready_at <= ${Math.floor(now)}`)} AS dueSessions,
      ${historyEnabled ? capped(`SELECT 1 FROM turn_cards INDEXED BY idx_turn_cards_uncovered WHERE state = 'carded' AND covered = 0`) : freshCount('due_cards')} AS dueCards,
      ${historyEnabled ? capped(`SELECT 1 FROM turn_cards INDEXED BY idx_turn_cards_due_all WHERE state = 'pending'`) : freshCount('pending_cards')} AS turnsAwaitingCards,
      ${historyEnabled ? '0' : capped(`SELECT 1 ${scopedSessions('idx_learning_source_waiting', `(${waiting}) AND NOT ((pending_cards > 0 AND ${freshRetrySql('cards')}) OR (eligible_at IS NOT NULL AND ${freshRetrySql('learning')}))`, false)}`)} AS historyWaiting,
      ${capped(`SELECT 1 FROM learning_sessions INDEXED BY idx_learning_init_pending WHERE init_state <> 'ready' AND init_state = 'awaiting_publication'`)} AS awaitingPublication`)
    .first<{ dueSessions: number; dueCards: number; turnsAwaitingCards: number; historyWaiting: number; awaitingPublication: number }>();
  const last = await db.prepare(`SELECT last_completed_at AS at, last_completed_reason AS reason, session_id AS sessionId FROM learning_sessions
    INDEXED BY idx_learning_completed WHERE last_completed_at IS NOT NULL ORDER BY last_completed_at DESC LIMIT 1`).first<{ at: number; reason: string; sessionId: string }>();
  return {
    dueSessions: row!.dueSessions, dueCards: row!.dueCards, turnsAwaitingCards: row!.turnsAwaitingCards,
    historyWaiting: row!.historyWaiting,
    awaitingPublication: row!.awaitingPublication, lastCompleted: last, cap: STATUS_CAP,
  };
}

/** The status line: what is due, what waits and why, the last completion, and spend against the day's budget. */
export function learningStatusLine(status: LearningStatus, budget: { dailyUsd: number; automaticUsd: number | null; manualUsd: number | null } | null, now: number): string {
  const n = (count: number) => (count > status.cap ? `at least ${status.cap}` : String(count));
  const parts = [
    `${n(status.dueSessions)} sessions due (${n(status.dueCards)} cards to learn)`,
    `${n(status.turnsAwaitingCards)} turns waiting for their card`,
    ...(status.historyWaiting > 0 ? [`${n(status.historyWaiting)} history sessions waiting behind the history switch`] : []),
    ...(status.awaitingPublication > 0 ? [`${n(status.awaitingPublication)} sessions waiting for publication`] : []),
    status.lastCompleted === null ? 'nothing learned yet'
      : `last ${status.lastCompleted.reason === 'no_signal' ? 'session closed with nothing to learn' : 'slice learned'} ${Math.max(0, Math.round((now - status.lastCompleted.at) / 60_000))} min ago`,
    ...(budget === null || budget.automaticUsd === null ? [] : [`spent $${(budget.automaticUsd + (budget.manualUsd ?? 0)).toFixed(2)} of $${budget.dailyUsd.toFixed(2)} today`]),
  ];
  return `Learning: ${parts.join('; ')}.`;
}
