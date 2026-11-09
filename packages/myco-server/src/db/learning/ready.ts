import type { RelationalStore } from '../../core/adapters.js';
import { commitNamed, read, readSet, write } from '../index.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { learningEnabledSql } from '../../core/settings.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { FRESH_LEARNING_MS, learningRangeSql } from '../runs/learning-policy.js';

/**
 * The deadline and ready relations of the two learning stages, and the pass that moves sessions between them.
 *
 * A session's stage is due at its deadline; the pass records that deadline in `*_promoted_at`, which is what makes the
 * session ready, so a later write to the deadline takes it out by itself and a landed write is seen by the next pass.
 * The ready relations hold a session once per stage, with its source-age bucket in the stage name, so a head reads one
 * stage in source order and stops at its first session whatever else is waiting. A pass also ages the sessions whose
 * source has gone past the freshness window, and promotion classifies the row it promotes the same way, so a session
 * promoted before the age page reaches it never reads as fresh. Every statement is capped, so a backlog drains over several passes.
 */
export type LearningStage = 'cardsFresh' | 'cardsHistory' | 'learningFresh' | 'learningHistory';
export const stageOf = (kind: 'cards' | 'learning', fresh: boolean): LearningStage =>
  `${kind}${fresh ? 'Fresh' : 'History'}` as LearningStage;

/** Rows a claim or status read promotes at most, per relation: small, so a backlog never spends the claim's reads. */
const CLAIM_ADVANCE_PAGE = 2;
/** Rows one job pass promotes or ages at most, per relation. */
export const LEARNING_ADVANCE_PAGE = 200;

const age = write<[cutoff: number, limit: number], { aged: number }>({ name: 'learningReady.age', sql: `UPDATE learning_sessions SET aged=1
  WHERE rowid IN (SELECT rowid FROM learning_sessions INDEXED BY idx_learning_aging
    WHERE aged=0 AND source_activity_at IS NOT NULL AND source_activity_at<=?1
    ORDER BY source_activity_at LIMIT ?2) RETURNING 1 AS aged` });
const promote = (stage: 'card' | 'learning') => write<[now: number, limit: number, cutoff: number], { promoted: number }>({
  name: `learningReady.promote${stage === 'card' ? 'Card' : 'Learning'}`, sql: `UPDATE learning_sessions SET ${stage}_promoted_at=${stage}_deadline,
      aged=CASE WHEN source_activity_at<=?3 THEN 1 ELSE aged END
    WHERE rowid IN (SELECT rowid FROM learning_sessions INDEXED BY idx_learning_${stage === 'card' ? 'card' : 'stage'}_deadline
      WHERE ${stage}_deadline IS NOT NULL AND ${stage}_promoted_at IS NOT ${stage}_deadline AND ${stage}_deadline<=?1
      ORDER BY ${stage}_deadline DESC,project_id,session_id LIMIT ?2) RETURNING 1 AS promoted` });
const promoteCards = promote('card');
const promoteLearning = promote('learning');

/**
 * One bounded pass over the deadlines. `more` holds while a relation filled its page and rows remain behind it. A claim
 * or status read promotes a small page and ages nothing, and each promotion classifies the session it moves; the job also ages the rest, and it alone walks the whole backlog.
 */
export async function advanceLearningDeadlines(db: RelationalStore, now: number, options: { page?: number; age?: boolean } = {}): Promise<{ changed: number; more: boolean }> {
  const page = options.page ?? CLAIM_ADVANCE_PAGE;
  const cutoff = now - FRESH_LEARNING_MS;
  const passed = await commitNamed(db, {
    cards: promoteCards.bind(now, page, cutoff),
    learning: promoteLearning.bind(now, page, cutoff),
    aged: options.age === true ? [age.bind(cutoff, page)] : [],
  });
  const results = [passed.cards, passed.learning, ...passed.aged];
  return { changed: results.reduce((sum, result) => sum + result.results.length, 0), more: results.some(result => result.results.length === page) };
}

const backlog = read<[now: number], { pending: number }>({ name: 'learningReady.backlog', sql: `SELECT EXISTS(SELECT 1 FROM learning_sessions INDEXED BY idx_learning_card_deadline
    WHERE card_deadline IS NOT NULL AND card_promoted_at IS NOT card_deadline AND card_deadline<=?1)
  OR EXISTS(SELECT 1 FROM learning_sessions INDEXED BY idx_learning_stage_deadline
    WHERE learning_deadline IS NOT NULL AND learning_promoted_at IS NOT learning_deadline AND learning_deadline<=?1) AS pending` });

/** Whether a session past its deadline still waits for promotion, read after a pass; a page that filled exactly leaves none. */
export async function learningDeadlinesPending(db: RelationalStore, now: number): Promise<boolean> {
  const [rows] = await readSet(db, backlog.bind(now));
  return rows[0]?.pending === 1;
}

const taskOf = (kind: 'cards' | 'learning') => kind === 'cards' ? CARD_TASK : EXTRACTION_TASK;
const subjectPrefix = (kind: 'cards' | 'learning') => kind === 'cards' ? 'cards:' : 'session:';
const notInFlight = (kind: 'cards' | 'learning') => `NOT EXISTS(SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_task_live
  WHERE r.task='${taskOf(kind)}' AND r.${IN_FLIGHT_RUN_STATUSES} AND r.subject='${subjectPrefix(kind)}'||l.session_id)`;
const readyIndex = (kind: 'cards' | 'learning') => kind === 'cards' ? 'idx_learning_card_ready' : 'idx_learning_stage_ready';
const stageColumn = (kind: 'cards' | 'learning') => kind === 'cards' ? 'card_stage' : 'learning_stage';

/**
 * The session `l` is ready at this stage. The fresh stages also hold the source window: a session that crossed it while
 * ready is out of the fresh stage at once and joins history when it is aged. A card session still uncounted is checked
 * against its turns, its old answer.
 */
export function learningEligible(kind: 'cards' | 'learning', fresh: boolean, now: string): string {
  const stage = stageOf(kind, fresh);
  return `l.${stageColumn(kind)}='${stage}' AND ${learningEnabledSql(!fresh)}${fresh ? ` AND ${learningRangeSql(kind, true, now)}` : ''}${kind === 'cards' ? ` AND (l.counted=1 OR EXISTS(SELECT 1 FROM turn_cards c INDEXED BY idx_turn_cards_model_due
    WHERE c.project_id=l.project_id AND c.session_id=l.session_id AND c.state='pending' AND c.due_at IS NOT NULL AND c.due_at<=${now}))` : ''}`;
}

/** A session of this stage in the Project the SQL expression `project` names is ready and has no run in flight. */
export const learningDue = (kind: 'cards' | 'learning', fresh: boolean, project: string, now: string): string =>
  `EXISTS(SELECT 1 FROM learning_sessions l INDEXED BY ${readyIndex(kind)} WHERE l.project_id=${project} AND ${learningEligible(kind, fresh, now)} AND ${notInFlight(kind)})`;

/** The Projects a stage's ready rows can come from: the summary of promoted rows, joined to the Project row. */
export const learningReadyProjects = (kind: 'cards' | 'learning', fresh: boolean): string =>
  `learning_ready_projects r CROSS JOIN projects p ON p.project_id=r.project_id AND r.stage='${stageOf(kind, fresh)}' AND r.ready>0`;

const heads = Object.fromEntries((['cards', 'learning'] as const).flatMap(kind => [true, false].map(fresh => [stageOf(kind, fresh), read<[project: string, now: number], Head>({
  name: `learningReady.head${stageOf(kind, fresh)}`,
  sql: `SELECT l.session_id AS sessionId,l.${kind === 'cards' ? 'source_activity_at' : 'eligible_at'} AS observed
    FROM learning_sessions l INDEXED BY ${readyIndex(kind)}
    WHERE l.project_id=?1 AND l.${kind === 'cards' ? 'card' : 'learning'}_deadline<=?2 AND ${learningEligible(kind, fresh, '?2')} AND ${notInFlight(kind)}
    ORDER BY l.source_activity_at DESC,l.session_id LIMIT 1`,
})]))) as Record<LearningStage, ReturnType<typeof read<[string, number], Head>>>;
type Head = { sessionId: string; observed: number };

/** The stage's head in a Project with no run of it in flight, or null. */
export async function stageHead(db: RelationalStore, stage: LearningStage, project: string, now: number): Promise<Head | null> {
  const [rows] = await readSet(db, heads[stage].bind(project, now));
  return rows[0] ?? null;
}

const handStartHeads = [true, false].map(fresh => read<[project: string, now: number], { sessionId: string }>({
  name: `learningReady.handStart${fresh ? 'Fresh' : 'History'}`,
  sql: `SELECT session_id AS sessionId FROM learning_sessions INDEXED BY idx_learning_source_eligible
    WHERE project_id=?1 AND eligible_at IS NOT NULL AND learning_ready_at<=?2 AND source_activity_at IS NOT NULL AND ${learningRangeSql('learning', fresh, '?2')}
    ORDER BY source_activity_at DESC,session_id LIMIT 1`,
}));

/**
 * A hand start's session: the Project's freshest one whose learning is due within the source range, whether or not a
 * deadline pass has promoted it yet, and whatever is in flight. A hand start reads its Project's own rows, so a backlog
 * elsewhere in the Deployment cannot hide it.
 */
export async function learningHeadSession(db: RelationalStore, project: string, now: number, fresh: boolean): Promise<string | null> {
  const [rows] = await readSet(db, handStartHeads[fresh ? 0 : 1]!.bind(project, now));
  return rows[0]?.sessionId ?? null;
}
