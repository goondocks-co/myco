import { subjectCanRetry } from '../runs/interruptions.js';
import { cardLearningAdmittedSql } from './admission.js';
import { MANUAL_LEARNING_REQUEST, manualCardSessionsSql } from './manual.js';
import type { RelationalStore } from '../../core/adapters.js';
import { commitNamed, read, readSet, write } from '../index.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { learningEnabledSql } from '../../db/settings/admission.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { LEARNING_WINDOW_MS, learningWindowSql } from '../runs/learning-policy.js';

/** Deadline promotion and bounded closure of unfinished sessions outside the learning window. */
export const LEARNING_STAGE_NAMES = ['cards', 'learning'] as const;
export type LearningStage = typeof LEARNING_STAGE_NAMES[number];

/** Rows a claim or status read promotes at most, per relation: small, so a backlog never spends the claim's reads. */
const CLAIM_ADVANCE_PAGE = 2;
/** Rows one job pass promotes or ages at most, per relation. */
export const LEARNING_ADVANCE_PAGE = 200;

const age = write<[cutoff: number, limit: number, now: number], { aged: number }>({ name: 'learningReady.age', sql: `UPDATE learning_sessions SET aged_out_at=?3,eligible_at=NULL
  WHERE rowid IN (SELECT rowid FROM learning_sessions INDEXED BY idx_learning_aging
    WHERE aged_out_at IS NULL AND source_activity_at IS NOT NULL AND (pending_cards>0 OR due_cards>0) AND source_activity_at<=?1
    ORDER BY source_activity_at LIMIT ?2) RETURNING 1 AS aged` });
const promote = (stage: 'card' | 'learning') => write<[now: number, limit: number, cutoff: number], { promoted: number }>({
  name: `learningReady.promote${stage === 'card' ? 'Card' : 'Learning'}`, sql: `UPDATE learning_sessions SET ${stage}_promoted_at=${stage}_deadline,
      aged_out_at=CASE WHEN source_activity_at<=?3 THEN ?1 ELSE aged_out_at END
    WHERE rowid IN (SELECT rowid FROM learning_sessions INDEXED BY idx_learning_${stage === 'card' ? 'card' : 'stage'}_deadline
      WHERE aged_out_at IS NULL AND ${stage}_deadline IS NOT NULL AND ${stage}_promoted_at IS NOT ${stage}_deadline AND ${stage}_deadline<=?1
      ORDER BY ${stage}_deadline DESC,project_id,session_id LIMIT ?2) RETURNING 1 AS promoted` });
const promoteCards = promote('card');
const promoteLearning = promote('learning');

/**
 * One bounded pass over the deadlines. `more` holds while a relation filled its page and rows remain behind it. A claim
 * or status read promotes a small page, closing expired sessions it encounters; the job also closes the rest of the backlog.
 */
export async function advanceLearningDeadlines(db: RelationalStore, now: number, options: { page?: number; age?: boolean } = {}): Promise<{ changed: number; more: boolean }> {
  const page = options.page ?? CLAIM_ADVANCE_PAGE;
  const cutoff = now - LEARNING_WINDOW_MS;
  const passed = await commitNamed(db, {
    cards: promoteCards.bind(now, page, cutoff),
    learning: promoteLearning.bind(now, page, cutoff),
    aged: options.age === true ? [age.bind(cutoff, page, now)] : [],
  });
  const results = [passed.cards, passed.learning, ...passed.aged];
  return { changed: results.reduce((sum, result) => sum + result.results.length, 0), more: results.some(result => result.results.length === page) };
}

const backlog = read<[now: number], { pending: number }>({ name: 'learningReady.backlog', sql: `SELECT EXISTS(SELECT 1 FROM learning_sessions INDEXED BY idx_learning_card_deadline
    WHERE aged_out_at IS NULL AND card_deadline IS NOT NULL AND card_promoted_at IS NOT card_deadline AND card_deadline<=?1)
  OR EXISTS(SELECT 1 FROM learning_sessions INDEXED BY idx_learning_stage_deadline
    WHERE aged_out_at IS NULL AND learning_deadline IS NOT NULL AND learning_promoted_at IS NOT learning_deadline AND learning_deadline<=?1) AS pending` });

/** Whether a session past its deadline still waits for promotion, read after a pass; a page that filled exactly leaves none. */
export async function learningDeadlinesPending(db: RelationalStore, now: number): Promise<boolean> {
  const [rows] = await readSet(db, backlog.bind(now));
  return rows[0]?.pending === 1;
}

const taskOf = (kind: 'cards' | 'learning') => kind === 'cards' ? CARD_TASK : EXTRACTION_TASK;
const subjectPrefix = (kind: 'cards' | 'learning') => kind === 'cards' ? 'cards:' : 'session:';
export const learningNotInFlight = (kind: 'cards' | 'learning') => `NOT EXISTS(SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_learning_subject_live
  WHERE r.task='${taskOf(kind)}' AND r.${IN_FLIGHT_RUN_STATUSES} AND r.subject='${subjectPrefix(kind)}'||l.session_id)`;
const readyIndex = (kind: 'cards' | 'learning') => kind === 'cards' ? 'idx_learning_card_ready' : 'idx_learning_stage_ready';
const stageColumn = (kind: 'cards' | 'learning') => kind === 'cards' ? 'card_stage' : 'learning_stage';

/**
 * When a session's stage is ready: `now`, promoted and due as a claim takes it; `later`, with a deadline its readiness
 * or retry backoff set and not aged out, which a deadline pass promotes once it comes. Each pairs with the same admission;
 * `later` reads the source window at that deadline, so a retry due after the window closes is not one.
 */
type Readiness = 'now' | 'later';
const READINESS: Readonly<Record<LearningStage, Record<Readiness, (now: string) => { automatic: string; manual: string; turn: string }>>> = {
  cards: {
    now: (now) => ({ automatic: "l.card_stage='cards'", manual: `l.card_deadline<=${now}`, turn: `c.due_at<=${now}` }),
    later: () => ({ automatic: 'l.card_deadline IS NOT NULL AND l.aged_out_at IS NULL', manual: 'l.card_deadline IS NOT NULL', turn: 'c.due_at IS NOT NULL' }),
  },
  learning: {
    now: () => ({ automatic: "l.learning_stage='learning'", manual: 'FALSE', turn: 'TRUE' }),
    later: () => ({ automatic: 'l.learning_deadline IS NOT NULL AND l.aged_out_at IS NULL', manual: 'FALSE', turn: 'TRUE' }),
  },
};

/** Automatic sessions and named manual requests admit model-due turns for card runs. */
export function learningEligible(kind: LearningStage, now: string, readiness: Readiness = 'now'): string {
  const at = READINESS[kind][readiness](now);
  const when = readiness === 'now' ? now : `MAX(${now},COALESCE(l.${kind === 'cards' ? 'card' : 'learning'}_deadline,${now}))`;
  const ready = kind === 'cards' ? cardLearningAdmittedSql(when, { automatic: at.automatic, manual: at.manual })
    : `${at.automatic} AND ${learningEnabledSql()} AND ${learningWindowSql(when)}`;
  return `${ready}${kind === 'learning' ? ` AND ${subjectCanRetry('l.project_id', `'${EXTRACTION_TASK}'`, "'session:'||l.session_id")}` : ''}${kind === 'cards' ? ` AND (l.counted=1 OR EXISTS(SELECT 1 FROM turn_cards c INDEXED BY idx_turn_cards_model_due
    WHERE c.project_id=l.project_id AND c.session_id=l.session_id AND c.state='pending' AND c.due_at IS NOT NULL AND ${at.turn}))` : ''}`;
}

/**
 * Whether the stage takes the session `subject` names again by itself, now or once its deadline comes: the session is
 * admitted under the same predicate its automatic claim reads, with `later` readiness. Past its window, or with
 * learning off, or out of interruptions, it is not.
 */
export const learningSubjectRetries = (kind: LearningStage, project: string, subject: string, now: string): string =>
  `EXISTS(SELECT 1 FROM learning_sessions l WHERE l.project_id=${project} AND l.session_id=substr(${subject},${subjectPrefix(kind).length + 1})
    AND ${subject}='${subjectPrefix(kind)}'||l.session_id AND ${learningEligible(kind, now, 'later')})`;

/** The Project has a ready session with no run in flight. */
export const learningDue = (kind: LearningStage, project: string, now: string): string =>
  `(EXISTS(SELECT 1 FROM learning_sessions l INDEXED BY ${readyIndex(kind)} WHERE l.project_id=${project} AND l.${stageColumn(kind)}='${kind}' AND ${learningEligible(kind, now)} AND ${learningNotInFlight(kind)})${kind === 'cards' ? ` OR EXISTS(SELECT 1 FROM ${manualCardSessionsSql(project)} WHERE ${learningEligible(kind, now)} AND ${learningNotInFlight(kind)})` : ''})`;

/** Projects with automatic readiness or named manual card work. */
export const learningReadyProjects = (kind: LearningStage): string =>
  kind === 'learning' ? `learning_ready_projects r CROSS JOIN projects p ON p.project_id=r.project_id AND r.stage='learning' AND r.ready>0`
    : `(SELECT project_id FROM learning_ready_projects WHERE stage='cards' AND ready>0
      UNION SELECT r.project_id FROM agent_runs r INDEXED BY idx_agent_runs_manual_learning WHERE ${MANUAL_LEARNING_REQUEST}) ready CROSS JOIN projects p ON p.project_id=ready.project_id`;

const automaticHead = (kind: LearningStage) => `SELECT l.session_id AS sessionId,l.${kind === 'cards' ? 'source_activity_at' : 'eligible_at'} AS observed
    FROM learning_sessions l INDEXED BY ${readyIndex(kind)}
    WHERE l.project_id=?1 AND l.${stageColumn(kind)}='${kind}' AND l.${kind === 'cards' ? 'card' : 'learning'}_deadline<=?2 AND ${learningEligible(kind, '?2')} AND ${learningNotInFlight(kind)}
    ORDER BY l.source_activity_at DESC,l.session_id LIMIT 1`;
const heads = Object.fromEntries(LEARNING_STAGE_NAMES.map(kind => [kind, read<[project: string, now: number], Head>({
  name: `learningReady.head${kind}`, sql: kind === 'learning' ? automaticHead(kind) : `SELECT * FROM (${automaticHead(kind)})
    UNION ALL SELECT l.session_id AS sessionId,l.source_activity_at AS observed FROM ${manualCardSessionsSql('?1')}
      WHERE ${learningEligible(kind, '?2')} AND ${learningNotInFlight(kind)} ORDER BY observed DESC,sessionId LIMIT 1`,
})])) as Record<LearningStage, ReturnType<typeof read<[string, number], Head>>>;
type Head = { sessionId: string; observed: number };

/** The stage's head in a Project with no run of it in flight, or null. */
export async function stageHead(db: RelationalStore, stage: LearningStage, project: string, now: number): Promise<Head | null> {
  const [rows] = await readSet(db, heads[stage].bind(project, now));
  return rows[0] ?? null;
}

const handStartHead = read<[project: string, now: number], { sessionId: string }>({
  name: 'learningReady.handStart',
  sql: `SELECT session_id AS sessionId FROM learning_sessions INDEXED BY idx_learning_source_eligible
    WHERE project_id=?1 AND eligible_at IS NOT NULL AND learning_ready_at<=?2 AND ${learningWindowSql('?2')}
    ORDER BY source_activity_at DESC,session_id LIMIT 1`,
});

/** An unnamed hand start reads the Project's newest due session inside the window. */
export async function learningHeadSession(db: RelationalStore, project: string, now: number): Promise<string | null> {
  const [rows] = await readSet(db, handStartHead.bind(project, now));
  return rows[0]?.sessionId ?? null;
}
