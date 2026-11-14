import type { RelationalStore } from '../../core/adapters.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { first, read } from '../index.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';

/** The session an owner explicitly named when requesting learning. */
export const MANUAL_LEARNING_SESSION = "CASE WHEN json_valid(r.dispatch_spec) THEN CASE WHEN json_type(r.dispatch_spec,'$.params.session_id')='text' THEN NULLIF(json_extract(r.dispatch_spec,'$.params.session_id'),'') END END";
export const MANUAL_LEARNING_REQUEST = `r.task='${EXTRACTION_TASK}' AND r.origin='manual' AND r.${IN_FLIGHT_RUN_STATUSES} AND ${MANUAL_LEARNING_SESSION} IS NOT NULL`;

export const MANUAL_LEARNING_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_agent_runs_manual_learning
  ON agent_runs(project_id,${MANUAL_LEARNING_SESSION.replaceAll('r.', '')}) WHERE ${MANUAL_LEARNING_REQUEST.replaceAll('r.', '')}`;

/** A named manual learning request admits its session's prerequisite card work. */
export const manualCardRequestSql = (scope?: { project: string; session: string }): string =>
  `EXISTS(SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_manual_learning WHERE ${MANUAL_LEARNING_REQUEST}${scope === undefined ? '' : ` AND r.project_id=${scope.project} AND ${MANUAL_LEARNING_SESSION}=${scope.session}`})`;

/** Manual requests seek their own Project's sessions, independent of the automatic ready relation. */
export const manualCardSessionsSql = (project: string): string => `agent_runs r INDEXED BY idx_agent_runs_manual_learning
  JOIN learning_sessions l ON l.project_id=r.project_id AND l.session_id=${MANUAL_LEARNING_SESSION}
  AND r.project_id=${project} AND ${MANUAL_LEARNING_REQUEST}`;

export const manualLearningNeedsCardsSql = (scope: { project: string; run: string }): string => `EXISTS(
  SELECT 1 FROM agent_runs r JOIN learning_sessions l ON l.project_id=r.project_id AND l.session_id=${MANUAL_LEARNING_SESSION}
  WHERE r.project_id=${scope.project} AND r.id=${scope.run} AND ${MANUAL_LEARNING_REQUEST} AND l.pending_cards>0)`;
const pending = read<[project: string, run: string], { pending: number }>({ name: 'learningManual.pendingCards',
  sql: `SELECT ${manualLearningNeedsCardsSql({ project: '?1', run: '?2' })} AS pending` });

/** A named learning request waits in its queue while its cards are unfinished. */
export async function manualLearningNeedsCards(db: RelationalStore, project: string, run: string): Promise<boolean> {
  return (await first(db, pending.bind(project, run)))?.pending === 1;
}
