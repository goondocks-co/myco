import { servedRecords } from '../db/runs/served.js';
import { learningCompleted } from '../db/runs/attributed-writes.js';
import type { Bound } from '../db/index.js';
import { learningRetryWrite, learningBackoffWrite } from '../db/runs/claim-companions.js';
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
 * Card counts are moved by triggers on the cards themselves (`db/learning/`), so progress here reads the session row.
 * Session learning progress and receipt-time claim admission share this per-session row.
 */
import type { RelationalStore } from './adapters.js';
import { LEARNING_SLICE_CHARS } from './read-window.js';
import { answerRoom, materialPages, type PagedEntry } from './material-pages.js';
import { commitAttributedWrite } from '../db/runs/attribution.js';
import { LEARNING_TOOL } from './tool-catalogue.js';
import { learningHistoryEnabled } from './settings.js';
import { FRESH_LEARNING_MS } from '../db/runs/learning-policy.js';
import { ackRecordStatement, assignableCards, assignedCardRows, completionProgressStatement, coverCardsStatement } from '../db/learning/progress.js';
import { advanceLearningDeadlines, learningDeadlinesPending } from '../db/learning/ready.js';
import { latestLearningCompletion, learningCountsReady, readLearningRollup } from '../db/learning/counts.js';

/** Due cards one slice reads at most. */
const LEARNING_SLICE_CARDS = 200;
/** How long a claimed learning slice keeps its session out of the eligible set before the claim is presumed lost. */
const LEARNING_CLAIM_MS = 900_000;
/** Backoff after repeated claims that never completed: 1 h, 6 h, then each 24 h. */
export const LEARNING_BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000] as const;
export const HANDOFF_MAX_BYTES = 4096;
/** The skip a hand start of learning ends with when no session has a due card. */
export const NOTHING_DUE = 'nothing_due';

/** One learning slice: the session, the cards it reads, and the progress revision its completion is guarded by. */
export interface LearningAssignment {
  kind: 'learning';
  expectedRevision: number;
  turns: { turnKey: string; inputHash: string }[];
  more: boolean;
  handoff: string | null;
}

/** The next slice of a session's due cards, oldest first, or null when none is due. */
export async function buildLearningAssignment(db: RelationalStore, projectId: string, sessionId: string): Promise<LearningAssignment | null> {
  const { progress, cards } = await assignableCards(db, projectId, sessionId, LEARNING_SLICE_CARDS + 1);
  if (progress === null) return null;
  const turns: LearningAssignment['turns'] = [];
  let room = LEARNING_SLICE_CHARS;
  for (const row of cards) {
    if (row.chars > room && turns.length > 0) break;
    room -= row.chars;
    turns.push({ turnKey: row.turnKey, inputHash: row.inputHash });
  }
  if (turns.length === 0) return null;
  return { kind: 'learning', expectedRevision: progress.revision, turns, more: turns.length < cards.length, handoff: progress.handoff };
}

/** Reserve the session and turn retry state under the claim's canonical attempt. */
export function claimLearningRetryWrite(projectId: string, sessionId: string,
  run: { runId: string; dispatchedBy: string }): Bound {
  return learningRetryWrite.bind(run.dispatchedBy, projectId, sessionId, projectId, run.runId, run.dispatchedBy);
}

/** A slice claim holds its session out of the eligible set until completion or lease loss. */
export function claimLearningWrites(projectId: string, sessionId: string, now: number,
  run: { runId: string; dispatchedBy: string }): Bound[] {
  return [claimLearningRetryWrite(projectId, sessionId, run), learningBackoffWrite.bind(now - FRESH_LEARNING_MS, now + LEARNING_CLAIM_MS, ...LEARNING_BACKOFF_MS, projectId, sessionId, run.runId, run.dispatchedBy)];
}

interface LearningCard { turnKey: string; card: string; signal: string; records: string; promptIds: string[] }

/** The assigned cards as they stand, verbatim, with the prompts each covers. */
export async function assignedCards(db: RelationalStore, projectId: string, sessionId: string, assignment: LearningAssignment): Promise<LearningCard[]> {
  const rows = await assignedCardRows(db, projectId, sessionId, JSON.stringify(assignment.turns));
  return rows.map((row) => ({
    ...row,
    records: row.records ?? '[]',
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
  const cards = await assignedCards(db, projectId, sessionId, assignment);
  const prompts = cards.flatMap((card) => card.promptIds);
  const servedIds = await servedRecords(db, { projectId }, runId, sessionId, prompts);
  if (prompts.some((id) => !servedIds.has(id))) return { completed: false, covered: 0 };
  const hashes = new Map(assignment.turns.map(turn => [turn.turnKey, turn.inputHash]));
  const assigned = JSON.stringify(cards.map(card => ({ turnKey: card.turnKey, inputHash: hashes.get(card.turnKey) })));
  const landedRevision = assignment.expectedRevision + 1;
  const result = await commitAttributedWrite(db, { projectId },
    learningCompleted.bind(assigned,projectId,sessionId,handoff,now,runId,assignment.expectedRevision),
    { runId, toolName: LEARNING_TOOL, op: 'complete', recordedAt: now, detail: { session_id: sessionId, cards: cards.length } },
    [
      coverCardsStatement(projectId, sessionId, assigned, landedRevision, runId),
      ...cards.flatMap(card => card.promptIds.map(promptId => ackRecordStatement({ ackId: crypto.randomUUID(), run: runId, now, project: projectId,
        served: servedIds.get(promptId)!, session: sessionId, landedRevision, turn: card.turnKey, inputHash: hashes.get(card.turnKey)! }))),
      completionProgressStatement(projectId, sessionId, now, landedRevision, runId, assigned),
    ]);
  const completed = result.results[0] as { covered: number } | undefined;
  return { completed: completed !== undefined, covered: completed?.covered ?? 0 };
}

interface LearningStatus {
  /** `ready`: every count is exact as of `asOf`. `building`: counts are lower bounds while existing sessions are counted. */
  state: 'ready' | 'building';
  asOf: number;
  dueSessions: number;
  dueCards: number;
  signalCards: number;
  turnsAwaitingCards: number;
  historyWaiting: number;
  awaitingPublication: number;
  readyProjects: number;
  /** The latest completion; null when none happened, undefined for a Project's status, which reads no completion. */
  lastCompleted: { at: number; reason: string; sessionId: string } | null | undefined;
}

/**
 * What learning has due and waiting, Deployment-wide or in one Project, from the maintained per-Project rollup: a read
 * of at most one row per Project whatever the sessions and cards behind it. A deadline pass runs first, so the ready
 * counts include what fell due just now. A Project's status leaves out the latest completion: no Project-led index
 * orders completions.
 */
export async function readLearningStatus(db: RelationalStore, now = Date.now(), scope?: { projectId: string }): Promise<LearningStatus> {
  await advanceLearningDeadlines(db, now);
  const [pending, historyEnabled, rollup, counted, last] = await Promise.all([
    learningDeadlinesPending(db, now),
    learningHistoryEnabled(db),
    readLearningRollup(db, scope),
    learningCountsReady(db),
    scope === undefined ? latestLearningCompletion(db) : Promise.resolve(undefined),
  ]);
  return {
    state: pending || !counted ? 'building' : 'ready', asOf: now,
    dueSessions: historyEnabled ? rollup.ready_sessions : rollup.fresh_ready_sessions,
    dueCards: historyEnabled ? rollup.due_cards : rollup.fresh_due,
    signalCards: rollup.signal_cards,
    turnsAwaitingCards: historyEnabled ? rollup.pending_cards : rollup.fresh_pending,
    historyWaiting: historyEnabled ? 0 : rollup.history_waiting,
    awaitingPublication: rollup.awaiting_publication,
    readyProjects: rollup.readyProjects,
    lastCompleted: last,
  };
}

/** The status line: what is due, what waits and why, the last completion, and spend against the day's budget. */
export function learningStatusLine(status: LearningStatus, budget: { dailyUsd: number; automaticUsd: number | null; manualUsd: number | null } | null, now: number, waitingForSignIn = false, heldByBudget = false): string {
  const n = (count: number, singular: string, plural = `${singular}s`) => `${status.state === 'building' ? `at least ${count}` : count} ${count === 1 && status.state !== 'building' ? singular : plural}`;
  const spent = budget?.automaticUsd == null ? null : budget.automaticUsd + (budget.manualUsd ?? 0);
  const ready = status.dueSessions > 0 || status.turnsAwaitingCards > 0 || status.state === 'building';
  const parts = [
    `${n(status.dueSessions, 'session')} ready to learn (${n(status.dueCards, 'summary', 'summaries')} to learn from)`,
    `${n(status.turnsAwaitingCards, 'turn')} waiting to be summarized`,
    ...(status.historyWaiting > 0 ? [`${n(status.historyWaiting, 'older session')} waiting for history learning to be enabled`] : []),
    ...(status.awaitingPublication > 0 ? [`${n(status.awaitingPublication, 'session')} waiting to become readable`] : []),
    ...(ready && waitingForSignIn ? ['waiting for a runner that can sign in'] : []),
    ...(ready && (heldByBudget || (spent !== null && budget !== null && spent >= budget.dailyUsd))
      ? ['learning resumes when the rolling 24 hour budget has room as earlier spending leaves the window'] : []),
    ...(status.lastCompleted === undefined ? [] : [status.lastCompleted === null ? 'nothing learned yet'
      : `last ${status.lastCompleted.reason === 'no_signal' ? 'session closed with nothing to learn' : 'learning completed'} ${Math.max(0, Math.round((now - status.lastCompleted.at) / 60_000))} min ago`]),
    ...(budget === null || spent === null ? [] : [`spent $${spent.toFixed(2)} of $${budget.dailyUsd.toFixed(2)} in the last 24 hours`]),
  ];
  return `${parts.join('; ')}.`;
}


