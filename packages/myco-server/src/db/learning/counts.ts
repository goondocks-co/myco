import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write } from '../index.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

const PAGE_KEYS = jsonKeys(['project_id', 'session_id']);
const COUNT_PAGE = 25;

const count = (predicate: string, hint = '') => `(SELECT COUNT(*) FROM turn_cards c ${hint} WHERE c.project_id=learning_sessions.project_id AND c.session_id=learning_sessions.session_id AND ${predicate})`;
/**
 * One page of the catch-up: each session's contribution re-derived from its cards in one statement, then its progress
 * settled, so a session reaches `counted = 1` holding its exact counts. Replaying a key is harmless: the values are
 * absolute, and from here on the triggers move them.
 */
const reconcile = write<[keys: string]>({ name: 'learningCounts.page', sql: `WITH keys AS (${PAGE_KEYS}) UPDATE learning_sessions SET
    pending_cards=${count("c.state='pending'", 'INDEXED BY idx_turn_cards_session_pending')},
    due_cards=${count("c.state='carded' AND c.covered=0", 'INDEXED BY idx_turn_cards_uncovered')},
    signal_cards=${count("c.state='carded' AND IFNULL(c.signal,'none')<>'none'")},
    last_carded_at=(SELECT MAX(c.carded_at) FROM turn_cards c WHERE c.project_id=learning_sessions.project_id AND c.session_id=learning_sessions.session_id AND c.state='carded'),
    next_model_due_at=(SELECT MIN(c.due_at) FROM turn_cards c WHERE c.project_id=learning_sessions.project_id AND c.session_id=learning_sessions.session_id AND c.state='pending' AND c.due_at IS NOT NULL),
    counted=1
  WHERE (project_id,session_id) IN (SELECT project_id,session_id FROM keys)` });

const settleProgress = write<[keys: string, now: number]>({ name: 'learningCounts.progress', sql: `WITH keys AS (${PAGE_KEYS}) UPDATE learning_sessions SET
    fresh_admitted=CASE WHEN pending_cards=0 AND due_cards=0 THEN 0 ELSE fresh_admitted END,
    eligible_at=CASE WHEN init_state='ready' AND skipped_by_owner=0 AND pending_cards=0 AND due_cards>0 THEN COALESCE(eligible_at,?2) ELSE NULL END
  WHERE (project_id,session_id) IN (SELECT project_id,session_id FROM keys)` });

export const LEARNING_COUNT_CATCHUP = {
  projection: 'learning_counts',
  phases: { learningCounts: {
    source: { table: 'learning_sessions', columns: ['project_id', 'session_id'], unique: true, pageSize: COUNT_PAGE },
    reconcile: [{ bind: (keys: string) => reconcile.bind(keys) }, { bindAt: (keys: string, now: number) => settleProgress.bind(keys, now) }],
  } },
} as const satisfies CatchupFamily;

export interface LearningRollup {
  pending_cards: number; due_cards: number; signal_cards: number; fresh_pending: number; fresh_due: number; ready_sessions: number;
  fresh_ready_sessions: number; history_waiting: number; awaiting_publication: number;
}
const ROLLUP = 'COALESCE(SUM(pending_cards),0) AS pending_cards,COALESCE(SUM(due_cards),0) AS due_cards,COALESCE(SUM(signal_cards),0) AS signal_cards,COALESCE(SUM(fresh_pending),0) AS fresh_pending,COALESCE(SUM(fresh_due),0) AS fresh_due,COALESCE(SUM(ready_sessions),0) AS ready_sessions,COALESCE(SUM(fresh_ready_sessions),0) AS fresh_ready_sessions,COALESCE(SUM(history_waiting),0) AS history_waiting,COALESCE(SUM(awaiting_publication),0) AS awaiting_publication';
const deploymentRollup = read<[], LearningRollup>({ name: 'learningCounts.deployment', sql: `SELECT ${ROLLUP} FROM learning_project_counts` });
const projectRollup = read<[project: string], LearningRollup>({ name: 'learningCounts.project', sql: `SELECT ${ROLLUP} FROM learning_project_counts WHERE project_id=?1` });
const readyProjects = read<[], { n: number }>({ name: 'learningCounts.readyProjects', sql: 'SELECT COUNT(*) AS n FROM (SELECT DISTINCT project_id FROM learning_ready_projects WHERE ready>0)' });
const readyInProject = read<[project: string], { n: number }>({ name: 'learningCounts.readyProject', sql: 'SELECT COUNT(*) AS n FROM (SELECT 1 FROM learning_ready_projects WHERE project_id=?1 AND ready>0 LIMIT 1)' });

/** One read of the maintained rollup, Deployment-wide or for one Project, and how many Projects have ready work. */
export async function readLearningRollup(db: RelationalStore, scope: { projectId: string } | undefined): Promise<LearningRollup & { readyProjects: number }> {
  const [rollup, ready] = scope === undefined
    ? await readSet(db, deploymentRollup.bind(), readyProjects.bind())
    : await readSet(db, projectRollup.bind(scope.projectId), readyInProject.bind(scope.projectId));
  return { ...rollup[0]!, readyProjects: ready[0]?.n ?? 0 };
}

const completed = read<[], { at: number; reason: string; sessionId: string }>({
  name: 'learningCounts.lastCompleted', sql: 'SELECT last_completed_at AS at,last_completed_reason AS reason,session_id AS sessionId FROM learning_sessions INDEXED BY idx_learning_completed WHERE last_completed_at IS NOT NULL ORDER BY last_completed_at DESC LIMIT 1' });

/** The Deployment's latest completion, or null when none has happened. */
export async function latestLearningCompletion(db: RelationalStore) {
  const [rows] = await readSet(db, completed.bind());
  return rows[0] ?? null;
}

const phase = read<[], { done: number }>({ name: 'learningCounts.ready', sql: "SELECT done FROM projection_catchup WHERE projection='learning_counts' AND phase='learningCounts'" });

/** Whether every existing session has been counted; a phase not yet seeded is not ready. */
export async function learningCountsReady(db: RelationalStore): Promise<boolean> {
  const [rows] = await readSet(db, phase.bind());
  return rows[0]?.done === 1;
}
